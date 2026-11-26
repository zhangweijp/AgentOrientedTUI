import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createRuntime } from '@aotui/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { AppCatalog } from '../src/app-distribution/app-catalog.js';
import { DesktopManager } from '../src/core/desktop-manager.js';

const PLANNING_APP_SOURCE = resolve(import.meta.dirname, '../../demo-apps/planning-app');
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function seedLegacyPlanningSqlite(dbPath: string, desktopId: string): void {
    const db = new Database(dbPath);
    try {
        db.exec(`
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
        db.prepare('INSERT INTO plans (id, desktop_id, title, description, created_at) VALUES (?, ?, ?, ?, ?)')
            .run('old_plan_1', desktopId, 'Old User Plan', 'Pre-existing SQLite data', now);
        db.prepare('INSERT INTO phases (id, plan_id, title, description, status, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run('old_phase_1', 'old_plan_1', 'Old User Phase', '', 'pending', 1, now);
        db.prepare('INSERT INTO todos (id, phase_id, title, description, status, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run('old_todo_1', 'old_phase_1', 'Old User Task', '', 'pending', 1, now);
    } finally {
        db.close();
    }
}

function getPlanningApp(desktop: Awaited<ReturnType<DesktopManager['createDesktop']>>['desktop']) {
    const info = desktop.listApps().find(a => a.installationId === 'planning');
    if (!info?.appId || !info.appInstanceId) {
        throw new Error(`Planning app not running: ${JSON.stringify(info)}`);
    }
    const found = desktop.getRunningApp(info.appId, info.appInstanceId);
    if (found.status !== 'ready') {
        throw new Error(`Planning app unavailable: ${JSON.stringify(found)}`);
    }
    return found.app;
}

async function waitForObservedText(
    desktop: Awaited<ReturnType<DesktopManager['createDesktop']>>['desktop'],
    needle: string,
    timeoutMs = 5000,
) {
    const running = getPlanningApp(desktop);
    const deadline = Date.now() + timeoutMs;
    let lastObserved: unknown;
    while (Date.now() < deadline) {
        const observed = await running.observe();
        lastObserved = observed;
        if (observed.status === 'prepared') {
            const snapshot = observed.candidate.observation;
            const adopted = desktop.adoptTurn({ apps: [{ candidate: observed.candidate }] });
            if (adopted.status === 'adopted') {
                adopted.turn.release();
            }
            if (JSON.stringify(snapshot.views).includes(needle)) {
                return snapshot;
            }
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    throw new Error(`Timed out waiting for view text: ${needle}; lastObserved=${JSON.stringify(lastObserved)}`);
}

describe('planning-app upgrade through Host DesktopManager with AOTUI_DATA_DIR', () => {
    afterAll(async () => {
        for (const dir of tempDirs) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('preserves pre-populated legacy planning.sqlite and persists selection changes across Host restarts when AOTUI_DATA_DIR is set', async () => {
        const root = await makeTempDir('aotui-host-planning-upgrade-');
        const appDir = join(root, 'planning-app-copy');
        const dataDir = join(appDir, 'data');
        const hostDataDir = join(root, 'host-data-dir');
        const desktopId = 'legacy_host_desktop';

        await mkdir(dataDir, { recursive: true });
        for (const entry of ['dist', 'package.json', 'aoapp.json']) {
            await cp(join(PLANNING_APP_SOURCE, entry), join(appDir, entry), { recursive: true });
        }
        await symlink(join(PLANNING_APP_SOURCE, 'node_modules'), join(appDir, 'node_modules'), 'junction');
        const sqliteFile = join(dataDir, 'planning.sqlite');
        seedLegacyPlanningSqlite(sqliteFile, desktopId);

        const catalog = new AppCatalog({ configPath: join(root, 'apps.json') });
        const runtime1 = createRuntime({ worker: { timeoutMs: 10000 } });
        try {
            const manager1 = new DesktopManager({ kernel: runtime1, appCatalog: catalog });
            await manager1.initialize({
                appEntries: [{ name: 'planning', source: `local:${appDir}`, enabled: true, autoStart: true }],
            });
            const { desktop: d1 } = await manager1.createDesktop(desktopId, { AOTUI_DATA_DIR: hostDataDir });
            const running1 = getPlanningApp(d1);

            await waitForObservedText(d1, 'Old User Plan');

            const obs1 = await running1.observe();
            expect(obs1.status).toBe('prepared');
            if (obs1.status !== 'prepared') throw new Error('expected prepared');
            const openTool = obs1.candidate.observation.tools.find(t => t.name === 'open_plan');
            expect(openTool).toBeDefined();
            const turn1 = d1.adoptTurn({ apps: [{ candidate: obs1.candidate }] });
            expect(turn1.status).toBe('adopted');
            if (turn1.status !== 'adopted') throw new Error('expected adopted');
            try {
                const invokeRes = await turn1.turn.invoke('planning_app', {
                    observationId: obs1.candidate.observation.observationId,
                    invocationId: 'open-legacy-plan',
                    toolId: openTool!.id,
                    input: { plan: '$ref.planning_app.plan_list.unfinished_plans[0]' },
                });
                expect(invokeRes.kind).toBe('receipt');
            } finally {
                turn1.turn.release();
            }

            await waitForObservedText(d1, 'Old User Task');
            const close1 = await runtime1.beginClose().completion;
            expect(close1.ok).toBe(true);
        } finally {
            await runtime1.beginClose().completion;
        }

        // Restart Host/DesktopManager with the same desktopId and AOTUI_DATA_DIR.
        const runtime2 = createRuntime({ worker: { timeoutMs: 10000 } });
        try {
            const manager2 = new DesktopManager({ kernel: runtime2, appCatalog: catalog });
            await manager2.initialize({
                appEntries: [{ name: 'planning', source: `local:${appDir}`, enabled: true, autoStart: true }],
            });
            const { desktop: d2 } = await manager2.createDesktop(desktopId, { AOTUI_DATA_DIR: hostDataDir });
            const restored = await waitForObservedText(d2, 'Old User Task');
            const text = JSON.stringify(restored.views);
            expect(text).toContain('Old User Plan');
            expect(text).toContain('Old User Phase');
            expect(text).toContain('Old User Task');
            expect(restored.views.some(v => v.id === 'plan_detail')).toBe(true);

            const close2 = await runtime2.beginClose().completion;
            expect(close2.ok).toBe(true);
        } finally {
            await runtime2.beginClose().completion;
        }

        const verifyDb = new Database(sqliteFile, { readonly: true, fileMustExist: true });
        try {
            const stateRow = verifyDb
                .prepare('SELECT active_plan_id FROM desktop_state WHERE desktop_id = ?')
                .get(desktopId) as { active_plan_id: string | null } | undefined;
            expect(stateRow?.active_plan_id).toBe('old_plan_1');
        } finally {
            verifyDb.close();
        }
    }, 30000);
});
