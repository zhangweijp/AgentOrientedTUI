import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PLANNING_DB_FILE, closeDatabase, createPlan, initDatabase } from '../src/db/index.js';
import { createRuntime, type RunningApp } from '../../../runtime/dist/index.js';

const entryUrl = pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

async function createLegacySqliteDb(dbPath: string, desktopId: string): Promise<void> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
        CREATE TABLE plans (
            id TEXT PRIMARY KEY,
            desktop_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE phases (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        );
        CREATE TABLE todos (
            id TEXT PRIMARY KEY,
            phase_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        );
    `);
    const now = Date.now();
    db.run('INSERT INTO plans (id, desktop_id, title, description, created_at) VALUES (?, ?, ?, ?, ?)', [
        'legacy_plan_1',
        desktopId,
        'Legacy Migration Plan',
        'Pre-upgrade plan',
        now,
    ]);
    db.run('INSERT INTO phases (id, plan_id, title, description, status, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        'legacy_phase_1',
        'legacy_plan_1',
        'Legacy Phase 1',
        '',
        'pending',
        1,
        now,
    ]);
    db.run('INSERT INTO todos (id, phase_id, title, description, status, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        'legacy_todo_1',
        'legacy_phase_1',
        'Legacy Task 1',
        '',
        'pending',
        1,
        now,
    ]);
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
}

async function waitForObservedText(
    running: RunningApp,
    needle: string,
    timeoutMs = 4000,
) {
    const deadline = Date.now() + timeoutMs;
    let lastObserved: unknown;
    while (Date.now() < deadline) {
        const observed = await running.observe();
        lastObserved = observed;
        if (observed.status === 'prepared') {
            const text = JSON.stringify(observed.candidate.observation.views);
            const snapshot = observed.candidate.observation;
            observed.candidate.discard();
            if (text.includes(needle)) {
                return snapshot;
            }
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    throw new Error(`Timed out waiting for view text: ${needle}; lastObserved=${JSON.stringify(lastObserved)}`);
}

async function callTool(
    desktop: Awaited<ReturnType<ReturnType<typeof createRuntime>['createDesktop']>>,
    running: Awaited<ReturnType<typeof desktop.installDynamicWorkerApp>>,
    toolName: string,
    input: Record<string, unknown>,
) {
    const observed = await running.observe();
    expect(observed.status, `observed=${JSON.stringify(observed)}`).toBe('prepared');
    if (observed.status !== 'prepared') {
        throw new Error(`Expected prepared observation, got ${observed.status}`);
    }
    const tool = observed.candidate.observation.tools.find(item => item.name === toolName);
    expect(tool, `Missing tool ${toolName}`).toBeDefined();
    const adopted = desktop.adoptTurn({ apps: [{ candidate: observed.candidate }] });
    expect(adopted.status).toBe('adopted');
    if (adopted.status !== 'adopted') {
        throw new Error(`Expected adopted turn, got ${adopted.status}`);
    }
    try {
        return await adopted.turn.invoke(running.appId, {
            observationId: observed.candidate.observation.observationId,
            invocationId: `${toolName}-${Date.now()}-${Math.random()}`,
            toolId: tool!.id,
            input,
        });
    } finally {
        adopted.turn.release();
    }
}

describe('planning-app self-managed sqlite persistence (Worker E2E)', () => {
    afterAll(() => {
        closeDatabase();
        for (const dir of tempDirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps default planning.sqlite path independent of AOTUI_DATA_DIR', () => {
        const prev = process.env.AOTUI_DATA_DIR;
        process.env.AOTUI_DATA_DIR = '/tmp/unrelated-aotui-data-dir';
        try {
            expect(DEFAULT_PLANNING_DB_FILE).toMatch(/demo-apps[\\/]planning-app[\\/]data[\\/]planning\.sqlite$/);
        } finally {
            if (prev === undefined) {
                delete process.env.AOTUI_DATA_DIR;
            } else {
                process.env.AOTUI_DATA_DIR = prev;
            }
        }
    });

    it('preserves pre-populated legacy plans/phases/tasks when opened with AOTUI_DATA_DIR and persists activePlanId across restart & explicit clear', async () => {
        const root = makeTempDir('planning-upgrade-');
        const dbPath = join(root, 'planning.sqlite');
        const desktopId = 'upgrade-desktop-1';
        await createLegacySqliteDb(dbPath, desktopId);

        const runtime = createRuntime({ worker: { timeoutMs: 10000 } });
        try {
            const firstDesktop = await runtime.createDesktop(desktopId);
            const firstApp = await firstDesktop.installDynamicWorkerApp(entryUrl, {
                installationId: 'planning-upgrade-1',
                config: {
                    AOTUI_DATA_DIR: join(root, 'host-data-dir'),
                    planningDbPath: dbPath,
                },
            });
            await waitForObservedText(firstApp, 'Legacy Migration Plan');

            const openReceipt = await callTool(firstDesktop, firstApp, 'open_plan', {
                plan: `$ref.${firstApp.appId}.plan_list.unfinished_plans[0]`,
            });
            expect(openReceipt.kind).toBe('receipt');
            if (openReceipt.kind === 'receipt') {
                expect(openReceipt.receipt.outcome.status).toBe('succeeded');
                if (openReceipt.receipt.outcome.status === 'succeeded') {
                    expect(openReceipt.receipt.outcome.value).toMatchObject({ success: true });
                }
            }
            await waitForObservedText(firstApp, 'Legacy Task 1');

            const firstClose = await firstDesktop.beginClose().completion;
            expect(firstClose.state).toBe('settled');
            expect(firstClose.ok).toBe(true);
            expect(firstClose.resourcesReleased).toBe(true);
            expect(firstClose.appCleanup).toMatchObject({ managedApps: 1, completedApps: 1, failedApps: 0 });

            // Restart with same desktopId & AOTUI_DATA_DIR: selection + legacy records must survive.
            const secondDesktop = await runtime.createDesktop(desktopId);
            const secondApp = await secondDesktop.installDynamicWorkerApp(entryUrl, {
                installationId: 'planning-upgrade-2',
                config: {
                    AOTUI_DATA_DIR: join(root, 'host-data-dir-2'),
                    planningDbPath: dbPath,
                },
            });
            const restored = await waitForObservedText(secondApp, 'Legacy Task 1');
            expect(restored.views.some((v: { id: string }) => v.id === 'plan_detail')).toBe(true);
            expect(restored.tools.some((t: { name: string }) => t.name === 'close_plan')).toBe(true);

            // Explicit close_plan persists null and remains closed after restart.
            const closePlanReceipt = await callTool(secondDesktop, secondApp, 'close_plan', {});
            expect(closePlanReceipt.kind).toBe('receipt');
            if (closePlanReceipt.kind === 'receipt') {
                expect(closePlanReceipt.receipt.outcome.status).toBe('succeeded');
            }
            await secondDesktop.beginClose().completion;

            const thirdDesktop = await runtime.createDesktop(desktopId);
            const thirdApp = await thirdDesktop.installDynamicWorkerApp(entryUrl, {
                installationId: 'planning-upgrade-3',
                config: {
                    AOTUI_DATA_DIR: join(root, 'host-data-dir-3'),
                    planningDbPath: dbPath,
                },
            });
            const cleared = await waitForObservedText(thirdApp, 'Legacy Migration Plan');
            expect(cleared.views.some((v: { id: string }) => v.id === 'plan_detail')).toBe(false);
            expect(cleared.tools.some((t: { name: string }) => t.name === 'close_plan')).toBe(false);
            await thirdDesktop.beginClose().completion;
        } finally {
            await runtime.beginClose().completion;
        }
    }, 30000);

    it('protects concurrent dual-Worker writers on the same sqlite file so every reported-success write is readable', async () => {
        const root = makeTempDir('planning-dual-');
        const dbPath = join(root, 'planning.sqlite');
        const runtime = createRuntime({ worker: { timeoutMs: 10000 } });
        try {
            const d1 = await runtime.createDesktop('dual-d1');
            const d2 = await runtime.createDesktop('dual-d2');
            const app1 = await d1.installDynamicWorkerApp(entryUrl, {
                installationId: 'p1',
                config: { planningDbPath: dbPath },
            });
            const app2 = await d2.installDynamicWorkerApp(entryUrl, {
                installationId: 'p2',
                config: { planningDbPath: dbPath },
            });
            await waitForObservedText(app1, 'Plan List');
            await waitForObservedText(app2, 'Plan List');

            const [r1, r2] = await Promise.all([
                callTool(d1, app1, 'create_plan', { title: 'Concurrent Plan One' }),
                callTool(d2, app2, 'create_plan', { title: 'Concurrent Plan Two' }),
            ]);

            await d1.beginClose().completion;
            await d2.beginClose().completion;

            await initDatabase(dbPath);
            const { getPlans } = await import('../src/db/index.js');
            const d1Plans = (await getPlans('dual-d1')).map(p => p.title);
            const d2Plans = (await getPlans('dual-d2')).map(p => p.title);

            const isToolSuccess = (inv: Awaited<ReturnType<typeof callTool>>) =>
                inv.kind === 'receipt' &&
                inv.receipt.outcome.status === 'succeeded' &&
                (inv.receipt.outcome.value as { success?: boolean })?.success === true;

            if (isToolSuccess(r1)) {
                expect(d1Plans).toContain('Concurrent Plan One');
            } else {
                expect(JSON.stringify(r1)).toContain('PLANNING_DB_BUSY');
            }
            if (isToolSuccess(r2)) {
                expect(d2Plans).toContain('Concurrent Plan Two');
            } else {
                expect(JSON.stringify(r2)).toContain('PLANNING_DB_BUSY');
            }
            expect(d1Plans.length + d2Plans.length).toBeGreaterThanOrEqual(1);
        } finally {
            closeDatabase();
            await runtime.beginClose().completion;
        }
    }, 30000);

    it('blocks live concurrent writers, reports unknown on Worker termination mid-rename, and recovers cleanly on reopen', async () => {
        const root = makeTempDir('planning-crash-');
        const dbPath = join(root, 'planning.sqlite');
        const pausedFlagPath = join(root, 'rename-paused.flag');
        const wrapperPath = join(root, 'pause-wrapper.mjs');
        const desktopId = 'crash-desktop-1';

        await initDatabase(dbPath);
        await createPlan(desktopId, 'Initial Plan');
        await createPlan('crash-desktop-2', 'Other Desktop Plan');
        closeDatabase();

        writeFileSync(wrapperPath, `
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import appFactory from ${JSON.stringify(entryUrl)};

const targetDbPath = ${JSON.stringify(dbPath)};
const pausedFlagPath = ${JSON.stringify(pausedFlagPath)};
const origRename = fs.rename.bind(fs);
fs.rename = async function (from, to) {
    if (String(to) === targetDbPath) {
        writeFileSync(pausedFlagPath, 'paused', 'utf8');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return origRename(from, to);
};

export default appFactory;
`, 'utf8');

        const runtime = createRuntime({ worker: { timeoutMs: 4000 } });
        try {
            const desktop1 = await runtime.createDesktop(desktopId);
            const app1 = await desktop1.installDynamicWorkerApp(pathToFileURL(wrapperPath).href, {
                name: 'planning_app',
                installationId: 'p-crash-1',
                config: { planningDbPath: dbPath },
            });
            await waitForObservedText(app1, 'Initial Plan');

            const desktop2 = await runtime.createDesktop('crash-desktop-2');
            const app2 = await desktop2.installDynamicWorkerApp(entryUrl, {
                installationId: 'p-crash-2',
                config: { planningDbPath: dbPath },
            });
            await waitForObservedText(app2, 'Other Desktop Plan');

            const observed1 = await app1.observe();
            expect(observed1.status).toBe('prepared');
            if (observed1.status !== 'prepared') throw new Error('Expected prepared observation');
            const createTool1 = observed1.candidate.observation.tools.find(t => t.name === 'create_plan');
            expect(createTool1).toBeDefined();
            const adopted1 = desktop1.adoptTurn({ apps: [{ candidate: observed1.candidate }] });
            expect(adopted1.status).toBe('adopted');
            if (adopted1.status !== 'adopted') throw new Error('Expected adopted turn');

            const pendingCreatePlan = adopted1.turn.invoke(app1.appId, {
                observationId: observed1.candidate.observation.observationId,
                invocationId: 'create-hang-1',
                toolId: createTool1!.id,
                input: { title: 'Interrupted Plan' },
            });

            const pauseDeadline = Date.now() + 5000;
            while (!existsSync(pausedFlagPath)) {
                if (Date.now() >= pauseDeadline) throw new Error('Timed out waiting for Worker 1 fs.rename pause');
                await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
            }

            // 1. Live Worker 1 cannot be preempted by Worker 2.
            // Stay paused longer than the retired 600 ms lease.
            await new Promise(resolveDelay => setTimeout(resolveDelay, 750));
            const liveContention = await callTool(desktop2, app2, 'create_plan', { title: 'Blocked While Live' });
            expect(liveContention).toMatchObject({
                kind: 'receipt',
                receipt: { outcome: { status: 'failed', details: { result: { error: { code: 'PLANNING_DB_BUSY' } } } } },
            });
            await desktop2.beginClose().completion;

            // 2. Terminating Worker 1 yields unknown closingInvocation & APP_INTERACTION_UNAVAILABLE without committing Interrupted Plan.
            const closeHandle1 = app1.beginClose();
            const [report1, inFlight1] = await Promise.all([closeHandle1.completion, pendingCreatePlan]);
            adopted1.turn.release();
            expect(inFlight1).toMatchObject({ kind: 'unavailable', code: 'APP_INTERACTION_UNAVAILABLE' });
            expect(report1.resourcesReleased).toBe(true);
            expect(report1.worker).toBe('exited');
            expect(report1.closingInvocation).toMatchObject({
                observationId: observed1.candidate.observation.observationId,
                invocationId: 'create-hang-1',
                executionPhase: 'unknown',
                status: 'unknown',
            });
            expect(existsSync(`${dbPath}.lock`)).toBe(true);

            const SQL = await initSqlJs();
            const diskCheck = new SQL.Database(readFileSync(dbPath));
            const rows = diskCheck.exec('SELECT title FROM plans');
            diskCheck.close();
            const diskTitles = (rows[0]?.values ?? []).map(row => String(row[0]));
            expect(diskTitles).toEqual(['Initial Plan', 'Other Desktop Plan']);

            // 3. New Worker 3 reopens cleanly, saves a new plan, closes cleanly, and Worker 4 restores it.
            await desktop1.beginClose().completion;
            const desktop3 = await runtime.createDesktop(desktopId);
            const app3 = await desktop3.installDynamicWorkerApp(entryUrl, {
                installationId: 'p-crash-3',
                config: { planningDbPath: dbPath },
            });
            await waitForObservedText(app3, 'Initial Plan');
            const recoveredWrite = await callTool(desktop3, app3, 'create_plan', { title: 'Recovered After Kill' });
            expect(recoveredWrite.kind).toBe('receipt');
            if (recoveredWrite.kind === 'receipt') {
                expect(recoveredWrite.receipt.outcome.status).toBe('succeeded');
                if (recoveredWrite.receipt.outcome.status === 'succeeded') {
                    expect(recoveredWrite.receipt.outcome.value).toMatchObject({ success: true });
                }
            }
            const close3 = await desktop3.beginClose().completion;
            expect(close3.ok).toBe(true);
            expect(close3.resourcesReleased).toBe(true);

            const desktop4 = await runtime.createDesktop(desktopId);
            const app4 = await desktop4.installDynamicWorkerApp(entryUrl, {
                installationId: 'p-crash-4',
                config: { planningDbPath: dbPath },
            });
            const restored = await waitForObservedText(app4, 'Recovered After Kill');
            expect(JSON.stringify(restored.views)).toContain('Initial Plan');
            expect(JSON.stringify(restored.views)).not.toContain('Interrupted Plan');
            await desktop4.beginClose().completion;
        } finally {
            await runtime.beginClose().completion;
        }
    }, 30000);
});
