import initSqlJs, { type Database } from 'sql.js';
import { randomUUID } from 'node:crypto';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { Plan, Phase, PhaseCompletion, TaskItem, TaskStatus } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_DATA_DIR = join(PROJECT_ROOT, 'data');
export const DEFAULT_PLANNING_DB_FILE = join(DEFAULT_DATA_DIR, 'planning.sqlite');
const SQLITE_BUSY = 5;

let activeDbFile = DEFAULT_PLANNING_DB_FILE;
let db: Database | null = null;
let SQL: initSqlJs.SqlJsStatic | null = null;
let lastDiskStamp: string | null = null;
let dbEpoch = 0;
let pendingInit: { targetFile: string; epoch: number; promise: Promise<Database> } | null = null;

function dbBusyError(): Error {
    return Object.assign(
        new Error(`Planning database is currently in use: ${activeDbFile}`),
        { code: 'PLANNING_DB_BUSY' },
    );
}

async function diskStamp(file: string): Promise<string | null> {
    try {
        const st = await fs.stat(file, { bigint: true });
        return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function loadFromDisk(): Promise<void> {
    if (!SQL) {
        throw new Error('SQL.js not initialized. Call initDatabase() first.');
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
        handle = await fs.open(activeDbFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
    }
    if (handle) {
        try {
            const before = await handle.stat({ bigint: true });
            const buffer = await handle.readFile();
            const after = await handle.stat({ bigint: true });
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
                throw new Error(`Planning database changed during read: ${activeDbFile}`);
            }
            const loaded = new SQL.Database(buffer);
            db?.close();
            db = loaded;
            lastDiskStamp = `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`;
        } finally {
            await handle.close();
        }
    } else {
        db?.close();
        db = new SQL.Database();
        lastDiskStamp = null;
    }
    initSchema();
}

async function withDbLock<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(dirname(activeDbFile), { recursive: true });
    // Keep the coordination file at a stable pathname. SQLite releases its
    // write transaction when the Worker closes or its environment exits.
    const lock = new DatabaseSync(activeDbFile + '.lock');
    try {
        try {
            lock.exec('BEGIN IMMEDIATE');
        } catch (error) {
            if ((error as { errcode?: number }).errcode === SQLITE_BUSY) throw dbBusyError();
            throw error;
        }
        return await action();
    } finally {
        lock.close();
    }
}

async function withDbMutation<T>(action: () => Promise<T>): Promise<T> {
    getDb();
    return withDbLock(async () => {
        const currentStamp = await diskStamp(activeDbFile);
        if (currentStamp !== lastDiskStamp) {
            await loadFromDisk();
        }
        return action();
    });
}

async function syncForRead(): Promise<Database> {
    const current = getDb();
    const currentStamp = await diskStamp(activeDbFile);
    if (currentStamp !== lastDiskStamp) {
        return withDbLock(async () => {
            if (await diskStamp(activeDbFile) !== lastDiskStamp) {
                await loadFromDisk();
            }
            return getDb();
        });
    }
    return current;
}

export async function initDatabase(dbFile?: string): Promise<Database> {
    const targetFile = dbFile ?? DEFAULT_PLANNING_DB_FILE;
    if (typeof targetFile !== 'string' || !isAbsolute(targetFile)) {
        throw Object.assign(new Error('Planning database path must be an absolute path'), { code: 'PLANNING_DB_PATH_INVALID' });
    }
    if (db && activeDbFile === targetFile) {
        return syncForRead();
    }
    if (pendingInit && pendingInit.targetFile === targetFile && pendingInit.epoch === dbEpoch) {
        return pendingInit.promise;
    }
    if (db && activeDbFile !== targetFile) {
        closeDatabase();
    }
    const epoch = dbEpoch;
    const promise = (async () => {
        activeDbFile = targetFile;

        if (!SQL) {
            SQL = await initSqlJs();
        }

        return withDbLock(async () => {
            if (epoch !== dbEpoch) {
                throw Object.assign(new Error('Planning database closed during initialization'), { code: 'PLANNING_DB_CLOSED' });
            }
            const existed = (await diskStamp(activeDbFile)) !== null;
            await loadFromDisk();
            if (!existed) {
                await saveToDisk();
            }
            if (epoch !== dbEpoch) {
                if (db) {
                    db.close();
                    db = null;
                }
                throw Object.assign(new Error('Planning database closed during initialization'), { code: 'PLANNING_DB_CLOSED' });
            }
            return getDb();
        });
    })();
    pendingInit = { targetFile, epoch, promise };
    try {
        return await promise;
    } finally {
        if (pendingInit?.promise === promise) {
            pendingInit = null;
        }
    }
}

async function saveToDisk(): Promise<void> {
    if (!db) return;
    const dir = dirname(activeDbFile);
    const pending = join(dir, `.planning-${randomUUID()}.tmp`);
    try {
        const handle = await fs.open(pending, 'wx', 0o600);
        try {
            await handle.writeFile(db.export());
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(pending, activeDbFile);
        lastDiskStamp = await diskStamp(activeDbFile);
    } catch (error) {
        // The in-memory commit must not leak into a later save after this write failed.
        closeDatabase();
        await fs.rm(pending, { force: true }).catch(() => {});
        throw error;
    }
}

function initSchema() {
    if (!db) return;
    db.run(`
        CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            desktop_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS phases (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS todos (
            id TEXT PRIMARY KEY,
            phase_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS desktop_state (
            desktop_id TEXT PRIMARY KEY,
            active_plan_id TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_plans_desktop_id ON plans(desktop_id);
        CREATE INDEX IF NOT EXISTS idx_phases_plan_id ON phases(plan_id);
        CREATE INDEX IF NOT EXISTS idx_phases_status ON phases(status);
        CREATE INDEX IF NOT EXISTS idx_todos_phase_id ON todos(phase_id);
        CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
    `);
}

function getDb(): Database {
    if (!db) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    return db;
}

function queryAll<T>(sql: string, params: any[] = []): T[] {
    const db = getDb();
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
}

function queryOne<T>(sql: string, params: any[] = []): T | null {
    const rows = queryAll<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
}

function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getNextPosition(table: 'phases' | 'todos', column: 'plan_id' | 'phase_id', id: string): number {
    const row = queryOne<{ max_pos: number }>(
        `SELECT COALESCE(MAX(position), 0) as max_pos FROM ${table} WHERE ${column} = ?`,
        [id]
    );
    return (row?.max_pos ?? 0) + 1;
}

function isPlanOwned(desktopId: string, planId: string): boolean {
    const row = queryOne<{ id: string }>(
        'SELECT id FROM plans WHERE id = ? AND desktop_id = ?',
        [planId, desktopId]
    );
    return Boolean(row);
}

function isPhaseOwnedByDesktop(desktopId: string, phaseId: string): boolean {
    const row = queryOne<{ id: string }>(
        `SELECT phases.id as id
         FROM phases
         JOIN plans ON plans.id = phases.plan_id
         WHERE phases.id = ? AND plans.desktop_id = ?`,
        [phaseId, desktopId]
    );
    return Boolean(row);
}

function isTodoOwnedByDesktop(desktopId: string, todoId: string): boolean {
    const row = queryOne<{ id: string }>(
        `SELECT todos.id as id
         FROM todos
         JOIN phases ON phases.id = todos.phase_id
         JOIN plans ON plans.id = phases.plan_id
         WHERE todos.id = ? AND plans.desktop_id = ?`,
        [todoId, desktopId]
    );
    return Boolean(row);
}

export async function getPlans(desktopId: string): Promise<Plan[]> {
    await syncForRead();
    const planRows = queryAll<{
        id: string;
        title: string;
        description: string;
    }>(
        'SELECT id, title, description FROM plans WHERE desktop_id = ? ORDER BY created_at ASC',
        [desktopId]
    );

    return planRows.map(planRow => {
        const phaseRows = queryAll<{
            id: string;
            title: string;
            description: string;
            status: TaskStatus;
        }>(
            'SELECT id, title, description, status FROM phases WHERE plan_id = ? ORDER BY position ASC',
            [planRow.id]
        );

        const phases: Phase[] = phaseRows.map(phaseRow => {
            const taskRows = queryAll<{
                id: string;
                title: string;
                description: string;
                status: TaskStatus;
            }>(
                'SELECT id, title, description, status FROM todos WHERE phase_id = ? ORDER BY position ASC',
                [phaseRow.id]
            );

            const tasks: TaskItem[] = taskRows.map(taskRow => ({
                id: taskRow.id,
                title: taskRow.title,
                description: taskRow.description,
                status: taskRow.status
            }));

            return { ...phaseRow, tasks };
        });

        return {
            id: planRow.id,
            title: planRow.title,
            description: planRow.description,
            phases
        };
    });
}

export async function getActivePlanId(desktopId: string): Promise<string | null> {
    await syncForRead();
    const row = queryOne<{ active_plan_id: string | null }>(
        'SELECT active_plan_id FROM desktop_state WHERE desktop_id = ?',
        [desktopId]
    );
    return row?.active_plan_id ?? null;
}

export async function setActivePlanId(desktopId: string, planId: string | null): Promise<void> {
    await withDbMutation(async () => {
        const db = getDb();
        db.run(
            `INSERT INTO desktop_state (desktop_id, active_plan_id) VALUES (?, ?)
             ON CONFLICT(desktop_id) DO UPDATE SET active_plan_id = excluded.active_plan_id`,
            [desktopId, planId]
        );
        await saveToDisk();
    });
}

export async function createPlan(desktopId: string, title: string, description: string = ''): Promise<Plan> {
    return withDbMutation(async () => {
        const db = getDb();
        const now = Date.now();
        const plan: Plan = {
            id: generateId('plan'),
            title,
            description,
            phases: []
        };

        db.run(
            `INSERT INTO plans (id, desktop_id, title, description, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [plan.id, desktopId, plan.title, plan.description ?? '', now]
        );
        await saveToDisk();
        return plan;
    });
}

export async function updatePlan(desktopId: string, planId: string, updates: { title?: string; description?: string }): Promise<boolean> {
    return withDbMutation(async () => {
        if (!isPlanOwned(desktopId, planId)) {
            return false;
        }
        const current = queryOne<{ title: string; description: string }>(
            'SELECT title, description FROM plans WHERE id = ?',
            [planId]
        );
        if (!current) {
            return false;
        }
        const nextTitle = updates.title ?? current.title;
        const nextDescription = updates.description ?? current.description;
        const db = getDb();
        db.run('UPDATE plans SET title = ?, description = ? WHERE id = ?', [
            nextTitle,
            nextDescription,
            planId
        ]);
        const changes = db.getRowsModified();
        if (changes > 0) {
            await saveToDisk();
        }
        return changes > 0;
    });
}

export async function deletePlan(desktopId: string, planId: string): Promise<boolean> {
    return withDbMutation(async () => {
        if (!isPlanOwned(desktopId, planId)) {
            return false;
        }
        const db = getDb();
        db.run('DELETE FROM todos WHERE phase_id IN (SELECT id FROM phases WHERE plan_id = ?)', [planId]);
        db.run('DELETE FROM phases WHERE plan_id = ?', [planId]);
        db.run('DELETE FROM plans WHERE id = ?', [planId]);
        const changes = db.getRowsModified();
        if (changes > 0) {
            await saveToDisk();
        }
        return changes > 0;
    });
}

export async function createPhase(desktopId: string, planId: string, title: string, description: string = ''): Promise<Phase | null> {
    return withDbMutation(async () => {
        if (!isPlanOwned(desktopId, planId)) {
            return null;
        }
        const db = getDb();
        const now = Date.now();
        const phase: Phase = { id: generateId('phase'), title, description, status: 'pending', tasks: [] };
        const position = getNextPosition('phases', 'plan_id', planId);
        db.run(
            `INSERT INTO phases (id, plan_id, title, description, status, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [phase.id, planId, phase.title, phase.description ?? '', phase.status, position, now]
        );
        await saveToDisk();
        return phase;
    });
}

export async function deletePhase(desktopId: string, phaseId: string): Promise<boolean> {
    return withDbMutation(async () => {
        if (!isPhaseOwnedByDesktop(desktopId, phaseId)) {
            return false;
        }
        const db = getDb();
        db.run('DELETE FROM todos WHERE phase_id = ?', [phaseId]);
        db.run('DELETE FROM phases WHERE id = ?', [phaseId]);
        const changes = db.getRowsModified();
        if (changes > 0) {
            await saveToDisk();
        }
        return changes > 0;
    });
}

export async function completePhase(desktopId: string, planId: string, phaseId: string): Promise<PhaseCompletion | null> {
    return withDbMutation(async () => {
        const phase = queryOne<{ title: string }>(
            `SELECT phases.title FROM phases
             JOIN plans ON plans.id = phases.plan_id
             WHERE phases.id = ? AND phases.plan_id = ? AND plans.desktop_id = ?`,
            [phaseId, planId, desktopId],
        );
        if (!phase) return null;

        const db = getDb();
        const now = Date.now();
        let phaseChanged: boolean;
        let tasksCompleted: number;
        db.run('BEGIN');
        try {
            db.run(
                `UPDATE phases SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending'`,
                [now, phaseId],
            );
            phaseChanged = db.getRowsModified() > 0;
            db.run(
                `UPDATE todos SET status = 'completed', completed_at = ? WHERE phase_id = ? AND status = 'pending'`,
                [now, phaseId],
            );
            tasksCompleted = db.getRowsModified();
            db.run('COMMIT');
        } catch (error) {
            db.run('ROLLBACK');
            throw error;
        }
        if (phaseChanged || tasksCompleted > 0) await saveToDisk();
        return { title: phase.title, phaseChanged, tasksCompleted };
    });
}

export async function createTodo(
    desktopId: string,
    phaseId: string,
    title: string,
    description: string = ''
): Promise<TaskItem | null> {
    return withDbMutation(async () => {
        if (!isPhaseOwnedByDesktop(desktopId, phaseId)) {
            return null;
        }
        const db = getDb();
        const now = Date.now();
        const task: TaskItem = {
            id: generateId('todo'),
            title,
            description,
            status: 'pending'
        };
        const position = getNextPosition('todos', 'phase_id', phaseId);
        db.run(
            `INSERT INTO todos (id, phase_id, title, description, status, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [task.id, phaseId, task.title, task.description ?? '', task.status, position, now]
        );
        await saveToDisk();
        return task;
    });
}

export async function updateTodo(
    desktopId: string,
    todoId: string,
    updates: { title?: string; description?: string }
): Promise<boolean> {
    return withDbMutation(async () => {
        if (!isTodoOwnedByDesktop(desktopId, todoId)) {
            return false;
        }
        const current = queryOne<{ title: string; description: string }>(
            'SELECT title, description FROM todos WHERE id = ?',
            [todoId]
        );
        if (!current) {
            return false;
        }
        const nextTitle = updates.title ?? current.title;
        const nextDescription = updates.description ?? current.description;
        const db = getDb();
        db.run('UPDATE todos SET title = ?, description = ? WHERE id = ?', [
            nextTitle,
            nextDescription,
            todoId
        ]);
        const changes = db.getRowsModified();
        if (changes > 0) {
            await saveToDisk();
        }
        return changes > 0;
    });
}

export async function completeTodo(desktopId: string, todoId: string): Promise<boolean> {
    return withDbMutation(async () => {
        if (!isTodoOwnedByDesktop(desktopId, todoId)) {
            return false;
        }
        const db = getDb();
        db.run(
            `UPDATE todos
             SET status = 'completed', completed_at = ?
             WHERE id = ? AND status = 'pending'`,
            [Date.now(), todoId]
        );
        const changes = db.getRowsModified();
        if (changes > 0) {
            await saveToDisk();
        }
        return changes > 0;
    });
}

export async function deleteTodo(desktopId: string, todoId: string): Promise<boolean> {
    return withDbMutation(async () => {
        if (!isTodoOwnedByDesktop(desktopId, todoId)) {
            return false;
        }
        const db = getDb();
        db.run('DELETE FROM todos WHERE id = ?', [todoId]);
        const changes = db.getRowsModified();
        if (changes > 0) {
            await saveToDisk();
        }
        return changes > 0;
    });
}

export function closeDatabase(): void {
    dbEpoch++;
    pendingInit = null;
    if (db) {
        db.close();
        db = null;
    }
    lastDiskStamp = null;
    activeDbFile = DEFAULT_PLANNING_DB_FILE;
}
