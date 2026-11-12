#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const vitest = spawn('npx', [
    'vitest',
    'run',
    '--project',
    'gui',
    'src/gui/components/settings/ConfigCard.property.test.ts'
], {
    cwd: __dirname,
    stdio: 'inherit'
});

vitest.on('close', (code) => {
    process.exit(code);
});
