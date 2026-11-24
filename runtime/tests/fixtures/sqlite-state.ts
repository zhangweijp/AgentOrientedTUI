import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** Inspect committed state on a separate, read-only SQLite connection. */
export function readSqliteState(root: string, desktop: string, app: string, key: string): string | undefined {
    const file = join(root, 'state.sqlite3');
    if (!existsSync(file)) return undefined;
    const Driver = require('better-sqlite3');
    const database = new Driver(file, { readonly: true, fileMustExist: true });
    try {
        if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'aotui_state'").get()) return undefined;
        const row = database.prepare('SELECT record FROM aotui_state WHERE namespace = ? AND key = ?')
            .get(JSON.stringify([desktop, app]), key);
        return row?.record?.toString('utf8');
    } finally { database.close(); }
}
