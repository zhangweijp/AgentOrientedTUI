/** M4 Stage 1 pure in-memory Tool registry microbenchmark; NOT product p95. */
import { performance } from 'node:perf_hooks';
import { createViewOwnedTools } from '../../runtime/src/core/tool/view-owned-tools.ts';

const schema = {
    name: 'lsp_hover',
    description: 'Hover a symbol',
    inputSchema: { type: 'object', properties: { line: { type: 'number' } } },
    isMutating: true,
};
function percentile(samples: number[], p: number): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 1000) / 1000;
}

for (const n of [1, 10, 100, 500, 1000]) {
    const registrationMs: number[] = [];
    const aggregationMs: number[] = [];
    for (let sample = 0; sample < 7; sample++) {
        const registry = createViewOwnedTools('bench', 'app_run_' + n + '_' + sample);
        const start = performance.now();
        for (let index = 0; index < n; index++) {
            const view = registry.mount('fd_' + index, 'FileDetail');
            registry.registerTool(view.viewInstanceId, schema,
                async () => ({ success: true }));
        }
        const registered = performance.now();
        const result = registry.listTools();
        const grouped = performance.now();
        if (result.length !== 1 || result[0].targets.length !== n) {
            throw Error('Aggregation invariant broken');
        }
        if (sample >= 2) {
            registrationMs.push(registered - start);
            aggregationMs.push(grouped - registered);
        }
    }
    console.log('M4_VIEW_TOOL_CORE_MICRO=' + JSON.stringify({
        views: n, iterations: registrationMs.length,
        register_p50_ms: percentile(registrationMs, 0.5),
        register_p95_ms: percentile(registrationMs, 0.95),
        aggregate_p50_ms: percentile(aggregationMs, 0.5),
        aggregate_p95_ms: percentile(aggregationMs, 0.95),
        note: 'Pure Core; excludes Preact, DOM, Worker, IPC, SDK schema converter, LSP and IDE I/O',
    }));
}
