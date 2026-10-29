import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileSystemService } from '../../../demo-apps/aotui-ide/src/core/file-system-service.ts';

function percentile(data: number[], percentile: number) {
    const ordered = [...data].sort((a, b) => a - b);
    return Math.round(ordered[Math.ceil(ordered.length * percentile) - 1] * 1000) / 1000;
}

async function main() {
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-versioned-bench-'));
try {
    for (const size of [1_024, 64 * 1_024, 1_024 * 1_024]) {
        const file = path.join(root, 'App-' + size + '.tsx');
        await fs.writeFile(file, 'x'.repeat(size));
        const reads: number[] = [];
        const writes: number[] = [];
        for (let i = 0; i < 25; i++) {
            const start = performance.now();
            const observed = await fileSystemService.readVersionedFile(root, file);
            const seen = performance.now();
            const content = String(i % 10) + 'x'.repeat(size - 1);
            const changed = await fileSystemService.replaceFileIfVersion(
                root, file, observed.version, content,
            );
            if (changed.status !== 'written') throw Error('Unexpected version conflict');
            const finished = performance.now();
            if (i >= 5) {
                reads.push(seen - start);
                writes.push(finished - seen);
            }
        }
        console.log('STAGE5_VERSIONED_FILE_BENCH=' + JSON.stringify({
            bytes: size, samples: reads.length,
            read_p50_ms: percentile(reads, 0.5), read_p95_ms: percentile(reads, 0.95),
            replace_p50_ms: percentile(writes, 0.5), replace_p95_ms: percentile(writes, 0.95),
            note: 'Local temp filesystem, SHA256 + cooperative wx lock + staged fsync + rename; no Worker, LSP or model',
        }));
    }
} finally {
    await fs.rm(root, { recursive: true, force: true });
}
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
