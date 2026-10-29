/** M1 pure-core microbenchmark, not a production workload or a Test Gate. */
import { performance } from 'node:perf_hooks';
import { createSnapshotCore, refKey } from '../../runtime/src/core/snapshot/index.ts';

function percentile(xs: number[], p: number) {
    const sorted = [...xs].sort((a,b) => a-b);
    return Number(sorted[Math.max(0, Math.ceil(p*sorted.length)-1)].toFixed(3));
}
for (const count of [1, 10, 50, 100]) {
    const core = createSnapshotCore({ maxHistoryEntries: 0, maxHistoryBytes: 0, limits: { maxSnapshotBytes: 16_000_000 } });
    core.lifecycle.startApp('bench', 'instance_' + count);
    const elapsed: number[] = [];
    for (let seq = 1; seq <= 25; seq++) {
        const views = Array.from({length:count}, (_,index) => ({
            id: 'v'+index, generation:'g', type: 'FileDetail', name:'View '+index,
            kind:'state', content: {format:'markdown-v1', value:'x'.repeat(1_000)+seq},
        }));
        const refs: Record<string,unknown> = {};
        for (let i=0;i<count;i++) refs[refKey('v'+i,'g','selected')] = {
            id:'selected',ownerViewId:'v'+i,ownerViewGeneration:'g',refType:'Task',
            target:{kind:'snapshot-value',payload:{id:i,version:seq}},
        };
        const draft = {
            schemaVersion:1,appId:'bench',instanceId:'instance_'+count,producerSeq:seq,sourceEpoch:seq,
            capturedAt:seq,views,refs,tools: {
                inspect: {
                    id:'inspect',name:'inspect',viewType:'FileDetail',description:'Inspect',
                    inputSchema:{type:'object',properties:{}},visible:true,isMutating:false,
                },
            },
        };
        const start = performance.now();
        const result = core.committer.accept(draft);
        const end = performance.now();
        if (result.status !== 'published') throw Error('Unexpected status: '+JSON.stringify(result));
        if (seq>5) elapsed.push(end-start);
    }
    console.log('M1_CORE_MICRO_BENCH='+JSON.stringify({
        views:count,iterations:elapsed.length,p50_ms:percentile(elapsed,.5),
        p95_ms:percentile(elapsed,.95),max_ms:percentile(elapsed,1),
        note:'Pure in-process Core only; no Preact, DOM, Worker, IPC or IDE I/O.',
    }));
}
