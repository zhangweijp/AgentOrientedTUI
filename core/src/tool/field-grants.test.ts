import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import type { RefGrant, RefConsumer } from '../invocation/observation-types.js';
import type { JsonValue, RefDescriptor } from '../snapshot/types.js';
import { compileToolParameters } from './tool-parameters.js';
import { prepareViewTypeParameters, reconstructToolParameters } from './snapshot-value-arguments.js';
import type { RefPath } from './ref-parameters.js';

function fixture() {
    const address = '$contacts.list.';
    const core = createSnapshotCore({ appId: 'contacts', instanceId: 'run' });
    const optionalContact = { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] };
    const compiled = compileToolParameters({ type: 'object', properties: {
        ordinary: {}, values: { type: 'array', items: {} },
        contact: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'Contact', 'x-aotui-ref-value': optionalContact },
        label: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'Contact', 'x-aotui-ref-value': { type: 'string' } },
        all: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'Contact', 'x-aotui-ref-value': { type: 'array', items: optionalContact } },
    }, additionalProperties: false });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled));
    const contract = compiled.contract;
    const tool = { id: JSON.stringify(['contacts', 'list', 'take']), name: 'take', viewType: 'list',
        multiplicity: 'single' as const, nameSharedAcrossViewTypes: false, description: 'Select a value', inputSchema: contract.schema };
    const payload = JSON.parse('[{"email":"a","phone":"private","0":null,"details":{"display.name":"","__proto__":false,"tags":[0,null,"$text"]}},{"email":"b"}]');
    const declaration = (id: string, marked: boolean): RefDescriptor => ({
        id, ownerViewId: 'list', ownerViewInstanceId: 'live', refType: 'Contact', scope: 'public',
        ...(marked ? { array: true as const } : {}), target: { kind: 'snapshot-value', payload },
    });
    const result = core.committer.accept({ schemaVersion: 7, appId: 'contacts', instanceId: 'run',
        producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ id: 'list', type: 'list', viewInstanceId: 'live', name: 'List', region: 'dynamic',
            content: { format: 'markdown-v1', value: 'Contacts' }, toolBindings: [{ toolId: tool.id, activationId: 'active' }] }],
        refs: { [refKey('list', 'live', 'people')]: declaration('people', true), [refKey('list', 'live', 'plain')]: declaration('plain', false) },
        tools: { [tool.id]: tool },
    });
    if (result.status !== 'published') throw new Error(JSON.stringify(result));
    const snapshotId = result.snapshot.id;
    const consumer = { appId: 'contacts', instanceId: 'run', viewId: 'list', viewInstanceId: 'live' };
    const receiver = { viewId: 'list', viewInstanceId: 'live', activationId: 'active' };
    const resolveRef = vi.fn(core.store.resolveRef);
    const store = { ...core.store, resolveRef };
    const source = { appId: 'contacts', instanceId: 'run', snapshotId, tool, receiver };
    const grant = (refId: string, paths?: readonly RefPath[], target?: RefConsumer): RefGrant =>
        ({ refId, viewId: 'list', viewInstanceId: 'live', ...(paths === undefined ? {} : { paths: paths.map(path =>
            ({ path, ...(target === undefined ? {} : { consumer: target }) })) }) });
    const prepare = (input: Readonly<Record<string, JsonValue>>, refs: readonly RefGrant[] = [grant('people'), grant('plain')]) =>
        prepareViewTypeParameters(store, source, contract, input, refs, 'obs');
    const worker = (raw: Readonly<Record<string, JsonValue>>, records: Parameters<typeof reconstructToolParameters>[3]) =>
        reconstructToolParameters(contract, raw, { ...source, observationId: 'obs' }, records);
    return { address, core, grant, prepare, resolveRef, worker, consumer };
}

describe('native Ref fields', () => {
    it('selects an allowed subtree and preserves typed keys, own keys, empty values and duplicate array slots', () => {
        const f = fixture(), a = f.address;
        const result = f.prepare({ values: [a + 'plain[0].details["display.name"]',
            a + 'plain[0]["0"]', a + 'plain[0].details["__proto__"]', a + 'plain[0].details.tags[0]',
            a + 'plain[0].details.tags[2]', a + 'plain[0]["0"]', '$$literal'] },
        [f.grant('plain', [[0, 'details'], [0, '0']])]);
        expect(result.status).toBe('prepared');
        if (result.status !== 'prepared') throw new Error(JSON.stringify(result));
        const effectiveArgs = { values: ['', null, false, 0, '$text', null, '$literal'] };
        expect(result.effectiveArgs).toEqual(effectiveArgs);
        expect(result.refSources.map(record => [record.index, record.path])).toEqual([
            [0, [0, 'details', 'display.name']], [1, [0, '0']], [2, [0, 'details', '__proto__']],
            [3, [0, 'details', 'tags', 0]], [4, [0, 'details', 'tags', 2]], [5, [0, '0']],
        ]);
        expect(f.worker(result.rawArgs, result.refSources)).toMatchObject({ status: 'prepared', effectiveArgs });
        const [first, ...remaining] = result.refSources;
        for (const patch of [{ index: 1 }, { path: [0, 'details'] }, { path: [0, 'details', 'name'] }, { path: ['0', 'details', 'display.name'] },
            { refType: 'Contact', arrayElement: true }]) {
            expect(f.worker(result.rawArgs, [{ ...first!, ...patch } as typeof first & object, ...remaining]))
                .toMatchObject({ status: 'rejected', issue: { code: 'E_INVALID_ARGS', path: '$.values[0]' } });
        }
        f.core.lifecycle.dispose();
    });

    it('looks up only authorized paths and never joins neighboring grants into a parent', () => {
        const f = fixture();
        const allowed = [f.grant('people', [[0, 'email'], [0, '0']], f.consumer)];
        const invalid = ['people', 'people[0]', 'people[0].phone', 'people[0].absent', 'people[0][0]', 'people["0"].email', 'people[1].email'];
        const rejected = invalid.map(address => f.prepare({ ordinary: f.address + address }, allowed));
        const problem = rejected[0];
        expect(rejected.every(result => JSON.stringify(result) === JSON.stringify(problem))).toBe(true);
        expect(problem).toMatchObject({ status: 'rejected', issue: { code: 'REF_NOT_VISIBLE', path: '$.ordinary' } });
        expect(f.prepare({ ordinary: f.address + 'people[0].email' }, [f.grant('people', [], f.consumer)])).toEqual(problem);
        for (const target of [{ ...f.consumer, appId: 'other' }, { ...f.consumer, instanceId: 'old' },
            { ...f.consumer, viewId: 'another' }, { ...f.consumer, viewInstanceId: 'old-mount' }]) {
            expect(f.prepare({ ordinary: f.address + 'people[0].email' }, [f.grant('people', [[0, 'email']], target)])).toEqual(problem);
        }
        expect(f.resolveRef).not.toHaveBeenCalled();
        expect(f.prepare({ ordinary: f.address + 'people' }, [f.grant('people', [[]], f.consumer)])).toMatchObject({ status: 'prepared' });
        f.core.lifecycle.dispose();
    });

    it.each([
        ['people[0].missing', 'segment 2 is absent'],
        ['people[4]', 'segment 1 is outside'],
        ['people[0].email[0]', 'segment 3 requires an array'],
        ['people[0][0]', 'segment 2 requires an array'],
        ['people["0"]', 'segment 1 requires a JSON object'],
    ])('reports the allowed but invalid path %s at the argument and segment', (address, message) => {
        const f = fixture();
        expect(f.prepare({ values: ['first', f.address + address] })).toMatchObject({ status: 'rejected',
            issue: { code: 'REF_TARGET_UNSUPPORTED', path: '$.values[1]', message: expect.stringContaining(message) } });
        f.core.lifecycle.dispose();
    });

    it('reserves nominal eligibility for whole Refs and actual declared ArrayRef elements', () => {
        const f = fixture(), a = f.address;
        const result = f.prepare({ all: a + 'people', contact: a + 'people[0]', ordinary: a + 'plain[0]' });
        expect(result.status).toBe('prepared');
        if (result.status !== 'prepared') throw new Error(JSON.stringify(result));
        expect(result.refSources.map(record => [record.refType, record.arrayElement])).toEqual([
            ['Contact', undefined], ['Contact', true], [undefined, undefined],
        ]);
        expect(f.worker(result.rawArgs, result.refSources).status).toBe('prepared');
        for (const input of [{ label: a + 'people[0].email' }, { contact: a + 'plain[0]' }])
            expect(f.prepare(input)).toMatchObject({ status: 'rejected', issue: { code: 'REF_TYPE_MISMATCH' } });
        f.core.lifecycle.dispose();
    });
});
