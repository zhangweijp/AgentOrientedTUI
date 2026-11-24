import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildAoappManifest, writeAoappManifest } from '../../sdk/bin/generate-aoapp.mjs';

const source = new URL('../examples/files/app.mts', import.meta.url);
const output = new URL('../dist/examples/files/', import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL('app.mjs', output), stripTypeScriptTypes(readFileSync(source, 'utf8')));
copyFileSync(new URL('package.json', source), new URL('package.json', output));
const appDirectory = fileURLToPath(new URL('.', source));
await writeAoappManifest(appDirectory, await buildAoappManifest(appDirectory));
chmodSync(new URL('../dist/stdio.js', import.meta.url), 0o755);
