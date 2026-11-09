import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

it('selects same-name lists and elements by View through SDK, Worker and Source, preserving typed display and observation lifetime', async () => {
    const data = await mkdtemp(join(tmpdir(), 'aotui-view-refs-'));
    const runtime = createRuntime({ worker: { timeoutMs: 5000, pool: { initialSize: 0, maxSize: 1 } } });
    let source: SemanticAOTUIDrivenSource | undefined;
    const contexts: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>[] = [];
    let sequence = 0;
    try {
        const desktop = await runtime.createDesktop('viewrefs');
        await runtime.installDynamicWorkerApp(desktop, new URL('../../sdk/test/fixtures/view-qualified-ref-app.mjs', import.meta.url).href,
            { appId: 'refviews', config: { AOTUI_DATA_DIR: data } });
        source = new SemanticAOTUIDrivenSource(runtime.getDesktop(desktop), runtime);
        const observe = async () => {
            const context = await source!.getContext(); contexts.push(context); await context.adopt(); return context;
        };
        const call = (context: typeof contexts[number], type: string, name: string, input: Record<string, unknown>) =>
            context.executeTool(`refviews-${type}-${name}`, input, 'viewrefs-' + sequence++);
        let current = await observe(); const original = current;
        const messages = current.messages.map(message => String(message.content)).join('\n');
        expect(messages).toContain('[Design A](Phase:completed_phases[0])');
        expect(messages).toContain('[Design B](Phase:completed_phases[0])');
        expect(messages).toContain('[Completed phases](Phase[]:completed_phases)');
        expect(String(current.messages[0]!.content)).toContain('plan_b.completed_phases[0]');
        expect(String(current.messages[0]!.content)).toContain('never its `type` or display `name`');
        for (const [view, owner] of [['plan_a', 'A'], ['plan_b', 'B']]) {
            expect(await call(current, 'Phases', 'read_item', { phase: view + '.completed_phases[0]' }))
                .toMatchObject({ outcomeStatus: 'succeeded', result: { owner, readonly: true } });
            expect(await call(current, 'Phases', 'read_list', { phases: view + '.completed_phases' }))
                .toMatchObject({ outcomeStatus: 'succeeded', result: { owners: [owner], readonly: true } });
        }
        for (const phase of ['completed_phases[0]', 'missing.completed_phases[0]', 'Phases.completed_phases[0]',
            'plan_b.Phase:completed_phases[0]', 'plan_b.completed_phases[0].owner']) {
            expect(await call(current, 'Phases', 'read_item', { phase }))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_NOT_VISIBLE' } });
        }
        expect(await call(current, 'Guide', 'update_b', {})).toMatchObject({ outcomeStatus: 'succeeded' });
        current = await observe();
        expect(await call(original, 'Phases', 'read_item', { phase: 'plan_b.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'rejected' });
        expect(await call(current, 'Phases', 'read_item', { phase: 'plan_b.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { owner: 'B updated' } });
        expect(await call(current, 'Guide', 'close_b', {})).toMatchObject({ outcomeStatus: 'succeeded' });
        current = await observe();
        expect(current.tools['refviews-Phases-read_item']).toBeDefined();
        expect(await call(current, 'Phases', 'read_item', { phase: 'plan_b.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_NOT_VISIBLE' } });
        expect(await call(current, 'Phases', 'read_item', { phase: 'plan_a.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { owner: 'A' } });
    } finally {
        for (const context of contexts) await context.release();
        await source?.dispose();
        const closed = await runtime.beginShutdown().completion;
        expect(closed).toMatchObject({ ok: true, resourcesReleased: true,
            interactions: { retainedScopes: 0, retainedBytes: 0 } });
        await rm(data, { recursive: true, force: true });
    }
}, 15000);
