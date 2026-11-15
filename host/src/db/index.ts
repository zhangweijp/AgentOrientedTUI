/**
 * System Chat Database Module
 * 
 * WASM (sql.js) persistence for topics and messages.
 * 
 * **Architecture**:
 * - Engine: SQLite compiled to WebAssembly (pure JS/WASM).
 * - Persistence: In-Memory DB loaded from/saved to Disk.
 * - Compatibility: CRUD methods are synchronous (Memory I/O), initialization is async.
 */
import initSqlJs, { type Database } from 'sql.js';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { Topic, Project } from '../types.js';
import { createMessagesV2Table } from '../db-v2.js';
import { createLLMConfigsTable } from './llm-config-db.js';
import { isIMSessionKey } from '../im/routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_DATA_DIR = join(PROJECT_ROOT, 'data');
const DEFAULT_DB_FILE = join(DEFAULT_DATA_DIR, 'chat.sqlite');

// Lazily resolve DB_FILE so process.env.DB_PATH (set in Electron's app.whenReady) is available
function getDbFile(): string {
    return process.env.DB_PATH ? resolve(process.env.DB_PATH) : DEFAULT_DB_FILE;
}

// Singleton instance
let db: Database | null = null;
let SQL: initSqlJs.SqlJsStatic | null = null;

/**
 * Initialize database (Async)
 */
export async function initDatabase(): Promise<Database> {
    if (db) return db;

    const dbFile = getDbFile();
    const dataDir = dirname(dbFile);

    // 1. Ensure Data Directory
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    // 2. Load WASM Engine
    if (!SQL) {
        SQL = await initSqlJs();
    }

    // 3. Load Data from Disk (if exists) or Create New
    const exists = existsSync(dbFile);
    if (exists) {
        const buffer = readFileSync(dbFile);
        db = new SQL.Database(buffer);
        console.log('[DB] WASM Database loaded from disk:', dbFile);
    } else {
        db = new SQL.Database();
        console.log('[DB] New WASM Database created in memory');
        initSchema(); // Only init schema for new DB
    }

    // 4. Run Migrations (Safe to run multiple times)
    migrateSchema();
    if (!exists) saveToDisk();

    return db;
}

/**
 * Persist Memory DB to Disk
 */
function saveToDisk() {
    if (!db) return;
    const data = db.export();
    writeFileSync(getDbFile(), data);
}

/**
 * Export saveToDisk for use by other modules (e.g., MessageServiceV2)
 */
export function persistDatabase(): void {
    saveToDisk();
}

/**
 * Initialize Tables
 */
function initSchema() {
    if (!db) return;

    db.run(`
        CREATE TABLE IF NOT EXISTS topics (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'hot',
            -- Chat App Enhancement Fields
            summary TEXT DEFAULT NULL,
            stage TEXT DEFAULT NULL,
            last_snapshot_time INTEGER DEFAULT NULL,
            project_id TEXT REFERENCES projects(id),
            model_override TEXT DEFAULT NULL,
            prompt_override TEXT DEFAULT NULL,
            agent_id TEXT DEFAULT NULL,
            source_controls TEXT DEFAULT NULL,
            context_compaction_controls TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS im_messages (
            id TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_im_messages_session_key ON im_messages(session_key);
        CREATE INDEX IF NOT EXISTS idx_im_messages_timestamp ON im_messages(timestamp);

        CREATE TABLE IF NOT EXISTS im_sessions (
            session_key TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            chat_type TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            account_id TEXT DEFAULT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_access_time INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_im_sessions_updated_at ON im_sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_im_sessions_channel ON im_sessions(channel);

        -- Projects table
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            last_opened_at INTEGER,
            created_at INTEGER NOT NULL
        );
    `);
    createMessagesV2Table(db);
}

/**
 * Migrate Schema (Add new columns/tables)
 */
function migrateSchema() {
    if (!db) return;

    // [LLM Configs] Create llm_configs table
    console.log('[DB] Ensuring llm_configs table exists...');
    createLLMConfigsTable(db);

    createMessagesV2Table(db);

    console.log('[DB] Ensuring im_messages table exists...');
    db.run(`
        CREATE TABLE IF NOT EXISTS im_messages (
            id TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_im_messages_session_key ON im_messages(session_key);
        CREATE INDEX IF NOT EXISTS idx_im_messages_timestamp ON im_messages(timestamp);
    `);

    console.log('[DB] Ensuring im_sessions table exists...');
    db.run(`
        CREATE TABLE IF NOT EXISTS im_sessions (
            session_key TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            chat_type TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            account_id TEXT DEFAULT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_access_time INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_im_sessions_updated_at ON im_sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_im_sessions_channel ON im_sessions(channel);
    `);

    // [RFC-025] Add Projects table
    db.run(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            last_opened_at INTEGER,
            created_at INTEGER NOT NULL
        );
    `);

    // [RFC-025] Add project_id to topics
    try {
        // Check if column exists
        const result = db.exec("SELECT project_id FROM topics LIMIT 1");
    } catch (e) {
        // Column doesn't exist, add it
        console.log('[DB] Migrating: Adding project_id to topics table');
        try {
            db.run("ALTER TABLE topics ADD COLUMN project_id TEXT REFERENCES projects(id)");
            saveToDisk();
        } catch (alterError) {
            console.error('[DB] Migration failed:', alterError);
        }
    }

    // Topic model override
    try {
        db.exec("SELECT model_override FROM topics LIMIT 1");
    } catch {
        console.log('[DB] Migrating: Adding model_override to topics table');
        try {
            db.run("ALTER TABLE topics ADD COLUMN model_override TEXT DEFAULT NULL");
            saveToDisk();
        } catch (alterError) {
            console.error('[DB] Migration failed:', alterError);
        }
    }

    // Topic prompt override
    try {
        db.exec("SELECT prompt_override FROM topics LIMIT 1");
    } catch {
        console.log('[DB] Migrating: Adding prompt_override to topics table');
        try {
            db.run("ALTER TABLE topics ADD COLUMN prompt_override TEXT DEFAULT NULL");
            saveToDisk();
        } catch (alterError) {
            console.error('[DB] Migration failed:', alterError);
        }
    }

    // Topic agent override
    try {
        db.exec("SELECT agent_id FROM topics LIMIT 1");
    } catch {
        console.log('[DB] Migrating: Adding agent_id to topics table');
        try {
            db.run("ALTER TABLE topics ADD COLUMN agent_id TEXT DEFAULT NULL");
            saveToDisk();
        } catch (alterError) {
            console.error('[DB] Migration failed:', alterError);
        }
    }

    // Topic source controls snapshot
    try {
        db.exec("SELECT source_controls FROM topics LIMIT 1");
    } catch {
        console.log('[DB] Migrating: Adding source_controls to topics table');
        try {
            db.run("ALTER TABLE topics ADD COLUMN source_controls TEXT DEFAULT NULL");
            saveToDisk();
        } catch (alterError) {
            console.error('[DB] Migration failed:', alterError);
        }
    }

    // Topic context compaction controls snapshot
    try {
        db.exec("SELECT context_compaction_controls FROM topics LIMIT 1");
    } catch {
        console.log('[DB] Migrating: Adding context_compaction_controls to topics table');
        try {
            db.run("ALTER TABLE topics ADD COLUMN context_compaction_controls TEXT DEFAULT NULL");
            saveToDisk();
        } catch (alterError) {
            console.error('[DB] Migration failed:', alterError);
        }
    }
}

/**
 * Get DB instance (Sync)
 * Assumes initDatabase() has been called and awaited at startup.
 */
export function getDb(): Database {
    if (!db) {
        throw new Error('Database not initialized. Call await initDatabase() first.');
    }
    return db;
}

// ============ Helper for sql.js Results ============

function rowToTopic(row: any): Topic {
    // sql.js getAsObject returns {col: val}
    return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
        summary: row.summary ?? undefined,
        stage: row.stage ?? undefined,
        lastSnapshotTime: row.last_snapshot_time ?? undefined,
        projectId: row.project_id ?? undefined,
        modelOverride: row.model_override ?? undefined,
        promptOverride: row.prompt_override ?? undefined,
        agentId: row.agent_id ?? undefined,
        sourceControls: (() => {
            if (!row.source_controls) return undefined;
            try {
                return JSON.parse(row.source_controls);
            } catch {
                return undefined;
            }
        })(),
        contextCompaction: (() => {
            if (!row.context_compaction_controls) return undefined;
            try {
                return JSON.parse(row.context_compaction_controls);
            } catch {
                return undefined;
            }
        })(),
    };
}

function rowToProject(row: any): Project {
    return {
        id: row.id,
        path: row.path,
        name: row.name,
        lastOpenedAt: row.last_opened_at ?? undefined,
        createdAt: row.created_at
    };
}

/**
 * Execute query and return typed array
 */
function queryAll<T>(sql: string, params: any[] = [], mapper: (row: any) => T): T[] {
    const db = getDb();
    const stmt = db.prepare(sql);
    stmt.bind(params);

    const results: T[] = [];
    while (stmt.step()) {
        results.push(mapper(stmt.getAsObject()));
    }
    stmt.free();
    return results;
}

/**
 * Execute query and return single item
 */
function queryOne<T>(sql: string, params: any[] = [], mapper: (row: any) => T): T | null {
    const items = queryAll(sql, params, mapper);
    return items.length > 0 ? items[0] : null;
}

// ============ Topics CRUD ============

export function createTopic(topic: Topic): void {
    const db = getDb();
    db.run(`
        INSERT INTO topics (id, title, created_at, updated_at, status, summary, stage, last_snapshot_time, project_id, model_override, prompt_override, agent_id, source_controls, context_compaction_controls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        topic.id, topic.title, topic.createdAt, topic.updatedAt, topic.status,
        topic.summary ?? null, topic.stage ?? null, topic.lastSnapshotTime ?? null, topic.projectId ?? null,
        topic.modelOverride ?? null, topic.promptOverride ?? null, topic.agentId ?? null, topic.sourceControls ? JSON.stringify(topic.sourceControls) : null,
        topic.contextCompaction ? JSON.stringify(topic.contextCompaction) : null
    ]);
    saveToDisk();
}

export function getTopic(id: string): Topic | null {
    return queryOne('SELECT * FROM topics WHERE id = ?', [id], rowToTopic);
}

export function getAllTopics(): Topic[] {
    return queryAll('SELECT * FROM topics ORDER BY updated_at DESC', [], rowToTopic)
        .filter((topic) => !isIMSessionKey(topic.id));
}

export function updateTopic(id: string, updates: Partial<Topic>): void {
    const db = getDb();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.updatedAt !== undefined) { fields.push('updated_at = ?'); values.push(updates.updatedAt); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.summary !== undefined) { fields.push('summary = ?'); values.push(updates.summary); }
    if (updates.stage !== undefined) { fields.push('stage = ?'); values.push(updates.stage); }
    if (updates.lastSnapshotTime !== undefined) { fields.push('last_snapshot_time = ?'); values.push(updates.lastSnapshotTime); }
    if (updates.projectId !== undefined) { fields.push('project_id = ?'); values.push(updates.projectId); }
    if (updates.modelOverride !== undefined) { fields.push('model_override = ?'); values.push(updates.modelOverride); }
    if (updates.promptOverride !== undefined) { fields.push('prompt_override = ?'); values.push(updates.promptOverride); }
    if (updates.agentId !== undefined) { fields.push('agent_id = ?'); values.push(updates.agentId); }
    if (updates.sourceControls !== undefined) { fields.push('source_controls = ?'); values.push(updates.sourceControls ? JSON.stringify(updates.sourceControls) : null); }
    if (updates.contextCompaction !== undefined) { fields.push('context_compaction_controls = ?'); values.push(updates.contextCompaction ? JSON.stringify(updates.contextCompaction) : null); }

    if (fields.length === 0) return;

    values.push(id);
    db.run(`UPDATE topics SET ${fields.join(', ')} WHERE id = ?`, values);

    if (db.getRowsModified() > 0) saveToDisk();
}

// ============ Projects CRUD ============

export function createProject(project: Project): void {
    const db = getDb();
    db.run(`
        INSERT INTO projects (id, path, name, last_opened_at, created_at)
        VALUES (?, ?, ?, ?, ?)
    `, [
        project.id, project.path, project.name,
        project.lastOpenedAt ?? null, project.createdAt
    ]);
    saveToDisk();
}

export function getProject(id: string): Project | null {
    return queryOne('SELECT * FROM projects WHERE id = ?', [id], rowToProject);
}

export function getAllProjects(): Project[] {
    return queryAll('SELECT * FROM projects ORDER BY last_opened_at DESC', [], rowToProject);
}

export function updateProject(id: string, updates: Partial<Project>): void {
    const db = getDb();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.path !== undefined) { fields.push('path = ?'); values.push(updates.path); }
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.lastOpenedAt !== undefined) { fields.push('last_opened_at = ?'); values.push(updates.lastOpenedAt); }

    if (fields.length === 0) return;

    values.push(id);
    db.run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, values);

    if (db.getRowsModified() > 0) saveToDisk();
}

export function deleteProject(id: string): void {
    const db = getDb();
    db.run('UPDATE topics SET project_id = NULL WHERE project_id = ?', [id]);
    db.run('DELETE FROM projects WHERE id = ?', [id]);
    saveToDisk();
}

export function deleteTopic(id: string): void {
    const db = getDb();
    // Honor the database's cascades when the user explicitly deletes a Topic.
    db.run('PRAGMA foreign_keys = ON');
    db.run('DELETE FROM topics WHERE id = ?', [id]);

    if (db.getRowsModified() > 0) saveToDisk();
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.log('[DB] Database closed');
    }
}
