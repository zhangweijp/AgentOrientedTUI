import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { createRuntime } from '@aotui/runtime';

const [mode, evidence] = process.argv.slice(2);
assert.ok(['baseline', 'headless', 'preview'].includes(mode) && evidence);
const state = await mkdtemp(join(import.meta.dirname, 'stream-'));
const entry = join(state, 'app.mjs'), go = join(state, 'go'), done = join(state, 'done');
await writeFile(entry, `
import { existsSync, writeFileSync } from 'node:fs';
import { createApp, createView, defineViewType } from '@aotui/sdk/app';
const Static = defineViewType({ name: 'static_page', multiplicity: 'multiple', region: 'static' });
const Log = defineViewType({ name: 'log', multiplicity: 'single', region: 'dynamic' });
export default createApp({ app_name: 'stream', viewTypes: [Static, Log], initialize(ctx) {
    let tick = 0, lines = [];
    const fixed = ['A','B'].map(letter => createView(Static, { render: () => ({ body: letter.repeat(25 * 1024) }) }));
    const log = createView(Log, { render: () => ({ body: (tick === 200 ? 'DONE' : 'Running') + ' ' + (tick * 5) + ' lines\\n' + lines.join('\\n') }) });
    const publish = () => ctx.prepareProjection({ views: [...fixed, log] });
    publish();
    const timer = setInterval(() => {
        if (tick === 0 && !existsSync(${JSON.stringify(go)})) return;
        for (let line = 1; line <= 5; line++) lines.push('Output line ' + (tick * 5 + line));
        lines = lines.slice(-30);
        tick++;
        publish();
        if (tick === 200) {
            clearInterval(timer);
            writeFileSync(${JSON.stringify(done)}, String(tick + 1));
        }
    }, 5);
    ctx.registerCleanup({ close: () => clearInterval(timer) });
}});
`);

const frames = [], signals = [], previews = [];
const emit = Worker.prototype.emit;
Worker.prototype.emit = function (event, message, ...rest) {
    if (event === 'message' && (message?.type === 'SNAPSHOT_PREPARED' || message?.type === 'PROJECTION_CURRENT')) {
        frames.push({ type: message.type, requested: Boolean(message.requestId), bytes: Buffer.byteLength(JSON.stringify(message)),
            bodyBytes: message.draft?.views.reduce((sum, view) => sum + Buffer.byteLength(view.content.value), 0) ?? 0 });
    }
    return emit.call(this, event, message, ...rest);
};
const runtime = createRuntime(), desktop = await runtime.createDesktop('stream-benchmark');
let timer, previewRead;
try {
    const app = await desktop.installDynamicWorkerApp(entry, { name: 'stream' });
    const realLog = views => views.find(view => view.id === 'log').content.value;
    const preview = async () => {
        const value = await app.preview();
        assert.equal(value.status, 'previewed');
        previews.push(realLog(value.views).split('\n')[0]);
    };
    desktop.output.subscribe(signal => {
        signals.push(signal);
        if (mode !== 'preview' || timer) return;
        timer = setTimeout(() => {
            timer = undefined;
            previewRead = preview();
        }, 150);
    });
    if (mode === 'preview') await preview();
    await writeFile(go, 'go');
    const until = Date.now() + 10_000;
    while (!existsSync(done) && Date.now() < until) await delay(15);
    assert.ok(existsSync(done), 'The App must commit all 1,000 lines.');
    if (mode === 'preview') {
        while (previews.at(-1) !== 'DONE 1000 lines' && Date.now() < until) await delay(15);
        await previewRead;
        assert.equal(previews.at(-1), 'DONE 1000 lines');
        assert.ok(previews.some(line => line !== 'Running 0 lines' && line.startsWith('Running ')));
    }
    const observed = await app.observe();
    assert.equal(observed.status, 'prepared');
    const observation = observed.candidate.observation;
    assert.match(realLog(observation.views), /^DONE 1000 lines\n/);
    assert.match(realLog(observation.views), /Output line 1000$/);
    assert.equal(observation.views.length, 3);
    assert.equal('sourceEpoch' in observation.source || 'producerSeq' in observation.source, false);
    assert.equal(desktop.adoptTurn({ apps: [{ candidate: observed.candidate }] }).status, 'adopted');
    const full = frames.filter(frame => frame.type === 'SNAPSHOT_PREPARED');
    if (mode !== 'baseline') {
        assert.equal(full.filter(frame => !frame.requested).length, 1);
        if (mode === 'headless') assert.equal(full.length, 2);
        if (mode === 'preview') assert.equal(frames[1]?.type, 'PROJECTION_CURRENT');
    }
    const closed = await runtime.beginClose().completion;
    assert.equal(closed.ok, true);
    await writeFile(resolve(evidence), JSON.stringify({ mode, fullFrames: full.length, fullFrameBytes: full.reduce((sum, item) => sum + item.bytes, 0),
        bodyBytes: full.reduce((sum, item) => sum + item.bodyBytes, 0), frames, signals, previews,
        final: realLog(observation.views), projectionCommits: Number(await readFile(done, 'utf8')), closed }, null, 2));
} finally {
    clearTimeout(timer);
    await runtime.beginClose().completion;
    Worker.prototype.emit = emit;
}
