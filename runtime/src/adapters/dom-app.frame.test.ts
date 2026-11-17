import { expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { readDOMAppViews } from './dom-app.js';
import { createSnapshotCore, SemanticProjectionCoordinator } from '../core/index.js';
import { compileToolParameters } from '../core/tool/tool-parameters.js';

function fixture(ids: string[] = []) {
    const { document } = parseHTML('<html><body><main></main></body></html>'), container = document.querySelector('main')!;
    const attachments = new WeakMap<object, { id: string; type: string; owner: object; bindings: []; refs: [] }>();
    for (const id of ids) {
        const node = document.createElement('section');
        node.setAttribute('data-view-id', id);
        node.setAttribute('data-view-type', 'File');
        node.setAttribute('data-view-kind', 'state');
        attachments.set(node, { id, type: 'File', owner: {}, bindings: [], refs: [] });
        container.appendChild(node);
    }
    const capture = () => readDOMAppViews(container, node => attachments.get(node));
    const views = () => capture().map(({ owner, bindings, refs, ...view }) => ({
        ...view, viewInstanceId: 'instance-' + view.id, toolBindings: [],
    }));
    return { document, container, capture, views };
}
const identity = () => ({ appId: 'app', instanceId: 'run' });

it('publishes an empty App frame with no Tools', () => {
    const f = fixture(), core = createSnapshotCore(identity());
    const projection = new SemanticProjectionCoordinator({ identity });
    expect(projection.commit(() => ({ views: f.views(), tools: [], refs: [] }))).toMatchObject({ status: 'prepared' });
    expect(projection.publishTo(core.committer)).toMatchObject({ status: 'published', snapshot: { views: [], refs: {}, tools: {} } });
    projection.close();
    core.lifecycle.dispose();
});

it('retains an empty-body View beside its healthy sibling and publishes the complete set', () => {
    const f = fixture(['healthy', 'empty']);
    f.container.querySelector('[data-view-id="healthy"]')!.textContent = 'HEALTHY_BODY';
    const core = createSnapshotCore(identity());
    const projection = new SemanticProjectionCoordinator({ identity });
    expect(projection.commit(() => ({ views: f.views(), tools: [], refs: [] }))).toMatchObject({ status: 'prepared' });
    expect(projection.publishTo(core.committer).status).toBe('published');
    expect(core.store.readLatest('app')).toMatchObject({
        status: 'ready',
        snapshot: { views: [{ id: 'healthy', content: { value: 'HEALTHY_BODY' } }, { id: 'empty', content: { value: '' } }] },
    });
    projection.close();
    core.lifecycle.dispose();
});

it('missing inventories fail closed', () => {
    const f = fixture(['a']);
    for (const value of [undefined, null, {}]) {
        expect(() => readDOMAppViews(f.container, value as any)).toThrow();
        const projection = new SemanticProjectionCoordinator({ identity });
        expect(projection.commit(() => ({ views: f.views(), tools: value as any, refs: [] }))).toMatchObject({ status: 'failed' });
        expect(projection.nextPublication()).toHaveProperty('failure');
    }
});

it('rejects orphan DOM pages, including when they are the only pages', () => {
    for (const ids of [[], ['a']]) {
        const f = fixture(ids), orphan = f.document.createElement('section');
        orphan.setAttribute('data-view-id', 'orphan');
        orphan.setAttribute('data-view-type', 'File');
        orphan.setAttribute('data-view-kind', 'state');
        f.container.appendChild(orphan);
        expect(() => f.capture()).toThrow(/attached View owner/);
    }
});

it('uses the complete ordered set inside the App root and rejects missing page IDs', () => {
    const f = fixture(['a', 'b']);
    const b = f.container.querySelector('[data-view-id="b"]')!;
    f.document.body.appendChild(b.cloneNode(true));
    expect(f.capture().map(view => view.id)).toEqual(['a', 'b']);
    b.setAttribute('id', 'can_only_be_a_dom_id');
    b.removeAttribute('data-view-id');
    expect(() => f.capture()).toThrow(/missing DOM View identity/);
    b.remove();
    expect(f.capture().map(view => view.id)).toEqual(['a']);
});

it('duplicate DOM, unattached nodes, wrong types, Ref owner and Tool target checks remain', () => {
    const f = fixture(['a']); const node = f.container.firstElementChild!;
    const duplicate = node.cloneNode(true); f.container.appendChild(duplicate);
    expect(() => f.capture()).toThrow(/Duplicate/); duplicate.remove();
    expect(() => readDOMAppViews(f.container, () => undefined)).toThrow(/attached View owner/);
    node.setAttribute('data-view-type', 'Wrong');
    expect(() => f.capture()).toThrow(/attached View owner/);
    node.setAttribute('data-view-type', 'File');
    const refs = new SemanticProjectionCoordinator({ identity });
    expect(refs.commit(() => ({ views: f.views(), tools: [], refs: [
        { viewId: 'missing', viewInstanceId: 'different', id: 'file', value: { text: 'x' } },
    ] }))).toMatchObject({ status: 'failed' });
    expect(refs.nextPublication()).toMatchObject({ failure: { issue: { message: expect.stringMatching(/missing View instance/) } } });

    const schema = compileToolParameters({ type: 'object', properties: {}, additionalProperties: false });
    if (!schema.ok) throw new Error('Invalid fixture schema');
    const tools = new SemanticProjectionCoordinator({ identity });
    expect(tools.commit(() => ({
        views: f.views(), refs: [], tools: [{ id: JSON.stringify(['app', 'Missing', 'read']), name: 'read', viewType: 'Missing',
            nameSharedAcrossViewTypes: false, description: 'Read', inputSchema: schema.contract.schema }],
    }))).toMatchObject({ status: 'failed' });
    expect(tools.nextPublication()).toMatchObject({ failure: { issue: { message: expect.stringMatching(/enabled View binding/) } } });
});
