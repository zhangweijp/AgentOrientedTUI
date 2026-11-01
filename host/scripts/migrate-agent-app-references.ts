import { readFile, writeFile, stat, rename } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { migrateAgentAppReferences } from '../src/config/app-reference-migration.js';

const { values } = parseArgs({ options: {
    config: { type: 'string' },
    registry: { type: 'string' },
    renames: { type: 'string' },
    write: { type: 'boolean', default: false },
} });
if (!values.config || !values.registry || !values.renames) {
    throw new Error('Usage: node --import tsx scripts/migrate-agent-app-references.ts --config <mcp.json> --registry <config.json> --renames <mapping.json> [--write]');
}
const original = await readFile(values.config, 'utf8');
const registry = JSON.parse(await readFile(values.registry, 'utf8'));
const renames = JSON.parse(await readFile(values.renames, 'utf8'));
const result = migrateAgentAppReferences(JSON.parse(original), registry.apps ?? {}, renames);
console.log(JSON.stringify({ mode: values.write ? 'write' : 'dry-run', changes: result.changes }, null, 2));
if (values.write && result.changes.length) {
    if (await readFile(values.config, 'utf8') !== original) throw new Error('Config changed during migration; retry with the latest file.');
    const mode = (await stat(values.config)).mode & 0o777;
    const backup = `${values.config}.before-app-reference-migration-${Date.now()}`;
    await writeFile(backup, original, { flag: 'wx', mode });
    const temporary = `${backup}.tmp`;
    await writeFile(temporary, JSON.stringify(result.config, null, 2) + '\n', { flag: 'wx', mode });
    await rename(temporary, values.config);
    console.log(JSON.stringify({ backup }));
}
