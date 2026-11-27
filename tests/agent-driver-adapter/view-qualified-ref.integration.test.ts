import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

it('selects same-name lists and elements by View through SDK, Worker and Source, preserving typed display and observation lifetime', async () => {
    const data = await mkdtemp(join(tmpdir(), 'aotui-view-refs-'));
    const runtime = createRuntime({ worker: { timeoutMs: 5000, maxWorkers: 1 } });
    let source: SemanticAOTUIDrivenSource | undefined;
    const contexts: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>[] = [];
    let sequence = 0;
    try {
        const desktop = await runtime.createDesktop('viewrefs');
        await desktop.installDynamicWorkerApp(new URL('../../sdk/test/fixtures/view-qualified-ref-app.mjs', import.meta.url).href,
            { name: 'refviews', config: { AOTUI_DATA_DIR: data } });
        source = new SemanticAOTUIDrivenSource(desktop);
        const observe = async () => {
            const context = await source!.getContext(); contexts.push(context); await context.adopt(); return context;
        };
        const call = (context: typeof contexts[number], type: string, name: string, input: Record<string, unknown>) =>
            context.executeTool(`refviews-${type}-${name}`, { view_id: type === 'Guide' ? 'root_1' : 'plan_a_1', ...input }, 'viewrefs-' + sequence++);
        let current = await observe(); const original = current;
        const messages = current.messages.map(message => String(message.content)).join('\n');
        expect(messages).toContain('[Design A](completed_phases[0])');
        expect(messages).toContain('[Design B](completed_phases[0])');
        expect(messages).toContain('[Completed phases](protected completed_phases: Phase[])');
        expect(String(current.messages[0]!.content)).toContain('$ref.contacts.list.people[0].email');
        for (const [view, owner] of [['plan_a_1', 'A'], ['plan_b_1', 'B']]) {
            expect(await call(current, 'Phases', 'read_item', { phase: '$ref.refviews.' + view + '.completed_phases[0]' }))
                .toMatchObject({ outcomeStatus: 'succeeded', result: { owner, readonly: true } });
            expect(await call(current, 'Phases', 'read_list', { phases: '$ref.refviews.' + view + '.completed_phases' }))
                .toMatchObject({ outcomeStatus: 'succeeded', result: { owners: [owner], readonly: true } });
        }
        for (const [phase, code] of [['completed_phases[0]', 'REF_TYPE_MISMATCH'],
            ['$ref.refviews.plan_b_1.Phase:completed_phases[0]', 'TOOL_INVALID_ARGS']]) {
            expect(await call(current, 'Phases', 'read_item', { phase }))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code } });
        }
        expect(await call(current, 'Phases', 'read_item', { phase: '$ref.refviews.plan_b_1.completed_phases[0].owner' }))
            .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_TYPE_MISMATCH' } });
        for (const phase of ['$ref.refviews.missing.completed_phases[0]', '$ref.refviews.Phases.completed_phases[0]']) {
            expect(await call(current, 'Phases', 'read_item', { phase }))
                .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_NOT_VISIBLE' } });
        }
        expect(await call(current, 'Guide', 'update_b', {})).toMatchObject({ outcomeStatus: 'succeeded' });
        current = await observe();
        expect(await call(original, 'Phases', 'read_item', { phase: '$ref.refviews.plan_b_1.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'rejected' });
        expect(await call(current, 'Phases', 'read_item', { phase: '$ref.refviews.plan_b_1.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { owner: 'B updated' } });
        expect(await call(current, 'Guide', 'close_b', {})).toMatchObject({ outcomeStatus: 'succeeded' });
        current = await observe();
        expect(current.tools['refviews-Phases-read_item']).toBeDefined();
        expect(await call(current, 'Phases', 'read_item', { phase: '$ref.refviews.plan_b_1.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_NOT_VISIBLE' } });
        expect(await call(current, 'Phases', 'read_item', { phase: '$ref.refviews.plan_a_1.completed_phases[0]' }))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { owner: 'A' } });
    } finally {
        for (const context of contexts) await context.release();
        await source?.dispose();
        const closed = await runtime.beginClose().completion;
        expect(closed).toMatchObject({ ok: true, resourcesReleased: true,
            interactions: { retainedOperations: 0 } });
        await rm(data, { recursive: true, force: true });
    }
}, 15000);
