/**
 * M0 SP-07: production-class projection microbenchmark (partial baseline).
 * Deliberately excludes SDK render, worker IPC, disk/network and full IDE.
 * Must NOT be presented as an end-to-end production benchmark.
 */
import { it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { performance } from 'node:perf_hooks';
import { transformElement } from '../../../runtime/src/engine/view/transformer/pure.ts';
import { createViewFragmentExtractor } from '../../../runtime/src/worker-runtime/view-fragment-extractor.ts';
import { SnapshotFormatter } from '../../../runtime/src/engine/view/snapshot/formatter.ts';
import { SnapshotRegistry } from '../../../runtime/src/engine/system/registry.ts';

function percentile(xs: number[], q: number) {
  const sorted = [...xs].sort((a, b) => a-b);
  return Math.round(sorted[Math.max(0, Math.min(sorted.length-1, Math.ceil(q * sorted.length)-1))] * 1000) / 1000;
}

it('M0 SP-07 measures DOM transform + View extraction + Formatter + Registry as a partial baseline', () => {
  const formatter = new SnapshotFormatter();
  const registry = new SnapshotRegistry({ ttl: 60_000 });
  const metadata: any = {
    getInstalledApps: () => [{ appId: 'app_0', name: 'Baseline IDE', status: 'running' }],
    getSystemLogs: () => [],
    getAppOperationLogs: () => [],
  };
  const summary: any[] = [];

  try {
    for (const count of [1, 10, 50, 100]) {
      const { document } = parseHTML('<html><body></body></html>');
      const container = document.createElement('div');
      container.innerHTML = Array.from({ length: count }, (_, index) => {
        const data = 'text'.repeat(256);
        return '<div data-view-id="view_' + index + '" data-view-type="FileDetail" data-view-name="File ' +
            index + '"><h3>File ' + index + '</h3><pre>' + data + '</pre></div>';
      }).join('');
      const extractor = createViewFragmentExtractor();
      const metrics: Record<string, number[]> = {
        domTransform: [], viewExtract: [], snapshotFormat: [], registryCreateRelease: [], total: [],
      };
      let viewCount = 0;
      let approxSerializedBytes = 0;
      const N = 35;
      for (let attempt = 0; attempt < N; attempt++) {
        const s0 = performance.now();
        const transformed = transformElement(container as any, 'app_0');
        const s1 = performance.now();
        const views = extractor(container as any, 'app_0' as any, Date.now());
        const s2 = performance.now();
        const merged = formatter.format([{
          appId: 'app_0', markup: transformed.markup,
          indexMap: transformed.indexMap, timestamp: Date.now(),
          views,
        }] as any, metadata);
        const s3 = performance.now();
        const snap = registry.create(merged.indexMap as any, merged.markup, undefined, merged.structured);
        registry.release(snap.id);
        const s4 = performance.now();
        viewCount = views.length;
        approxSerializedBytes = Buffer.byteLength(JSON.stringify({ markup: merged.markup, structured: merged.structured, indexMap: merged.indexMap }));
        if (attempt >= 5) {
          metrics.domTransform.push(s1-s0);
          metrics.viewExtract.push(s2-s1);
          metrics.snapshotFormat.push(s3-s2);
          metrics.registryCreateRelease.push(s4-s3);
          metrics.total.push(s4-s0);
        }
      }
      expect(viewCount).toBe(count);
      summary.push({
        views: count,
        bytes: approxSerializedBytes,
        iterations: N-5,
        stagesMs: Object.fromEntries(Object.entries(metrics).map(([k,x])=>[k,{p50: percentile(x,.5),p95:percentile(x,.95),max:percentile(x,1)}])),
      });
    }
    console.log('M0_SP07_PROJECTION_PERF=' + JSON.stringify({ node: process.version, partialBaseline: true, summary }));
  } finally {
    registry.shutdown();
  }
});
