import { expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureDOMSnapshot } from './dom-snapshot-producer.js';
import { createSnapshotCore } from '../core/index.js';

function fixture(ids: string[] = []) {
    const { document } = parseHTML('<html><body><main></main></body></html>'), container = document.querySelector('main')!;
    const views = ids.map(viewId => ({ viewId, viewInstanceId: 'instance-' + viewId, viewType: 'File' }));
    for (const view of views) { const node = document.createElement('section');node.setAttribute('data-view-id', view.viewId);node.setAttribute('data-view-instance-id', view.viewInstanceId);container.appendChild(node); }
    return { document, container, views, input: { appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 0, container,
        fragments: ids.map(viewId => ({ viewId: viewId as any, viewType: 'File', markup: 'stable', kind: 'state' as const })),
        kernel: { getViewOwnedViewInstances: () => views, getToolDefinitions: () => [], getViewRefs: () => [] } } };
}
const capture = (input: any) => captureDOMSnapshot(input);

it('C04 explicit empty owned inventories produce a legal V3 snapshot with no tools', () => {
    const f = fixture(), draft = capture(f.input);expect(draft).toMatchObject({ schemaVersion: 3, views: [], refs: {}, tools: {} });
    const core = createSnapshotCore();core.lifecycle.startApp('app', 'run');expect(core.committer.accept(draft).status).toBe('published');core.lifecycle.dispose();
});

it('retains an empty-body View beside its healthy sibling and publishes the complete set', () => {
    const f = fixture(['healthy', 'empty']);
    const fragments = f.input.fragments.map(fragment => ({
        ...fragment,
        markup: fragment.viewId === 'empty' ? '' : 'HEALTHY_BODY',
    }));
    const draft = capture({ ...f.input, fragments });
    expect(draft.views.map(view => [view.id, view.content.value])).toEqual([
        ['healthy', 'HEALTHY_BODY'],
        ['empty', ''],
    ]);

    const core = createSnapshotCore();
    core.lifecycle.startApp('app', 'run');
    expect(core.committer.accept(draft).status).toBe('published');
    expect(core.store.readLatest('app')).toMatchObject({
        status: 'ready',
        snapshot: { views: [{ id: 'healthy' }, { id: 'empty', content: { value: '' } }] },
    });
    core.lifecycle.dispose();
});

it.each(['getViewOwnedViewInstances', 'getToolDefinitions', 'getViewRefs'])('C06 missing or noncallable %s never means empty inventory', method => {
    for (const value of [undefined, null, [], {}]) { const f = fixture(['a']);(f.input.kernel as any)[method] = value;expect(() => capture(f.input)).toThrow(); }
    const f = fixture();expect(() => capture({ ...f.input, kernel: null })).toThrow();
});

it('C06 zero fragments with orphan DOM nodes and extra DOM beside owned Views reject', () => {
    for (const ids of [[], ['a']]) { const f = fixture(ids), orphan = f.document.createElement('section');orphan.setAttribute('data-view-id', 'orphan');f.container.appendChild(orphan);
        expect(() => capture(f.input)).toThrow(/complete set/); }
});

it('C06 fragments must be exactly the owned/DOM identity set, including duplicate and missing cases', () => {
    const f = fixture(['a', 'b']);expect(capture(f.input).views).toHaveLength(2);
    for (const fragments of [[], [f.input.fragments[0]], [f.input.fragments[0], f.input.fragments[0]], [...f.input.fragments, f.input.fragments[0]],
        [f.input.fragments[0], { ...f.input.fragments[1], viewId: 'orphan' }]]) expect(() => capture({ ...f.input, fragments })).toThrow();
    f.container.querySelector('[data-view-id="b"]')!.remove();expect(() => capture(f.input)).toThrow(/complete set/);
});

it('C06 existing duplicate DOM, duplicate owned IDs, wrong instance/type, Ref owner and Tool target checks remain', () => {
    const f = fixture(['a']);const node = f.container.firstElementChild!;
    const duplicate = node.cloneNode(true);f.container.appendChild(duplicate);expect(() => capture(f.input)).toThrow(/Duplicate/);duplicate.remove();
    expect(() => capture({ ...f.input, kernel: { ...f.input.kernel, getViewOwnedViewInstances: () => [f.views[0], f.views[0]] } })).toThrow(/Duplicate/);
    node.setAttribute('data-view-instance-id', 'wrong');expect(() => capture(f.input)).toThrow(/identity/);node.setAttribute('data-view-instance-id', f.views[0].viewInstanceId);
    expect(() => capture({ ...f.input, fragments: [{ ...f.input.fragments[0], viewType: 'Wrong' }] })).toThrow(/identity/);
    expect(() => capture({ ...f.input, kernel: { ...f.input.kernel, getViewRefs: () => [{ viewId: 'missing', refId: 'file', value: { text: 'x' } }] } })).toThrow(/owner/);
    expect(() => capture({ ...f.input, kernel: { ...f.input.kernel, getToolDefinitions: () => [{ id: 'tool', name: 'read', viewType: 'Missing',
        description: 'Read', inputSchema: { type: 'object', properties: {} }, 
        execution: { kind: 'view-type', activationId: 'active' } }] } })).toThrow(/no live matching View/);
});
