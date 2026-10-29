import { describe, expect, it } from 'vitest';
import { canonicalJson, utf8Size } from '../core/snapshot/json.js';
import { captureRefCapabilities, captureRefV1Json, captureRefV1Request, captureRefV1Terminal,
    REF_V1_MESSAGE_LIMITS, REF_V1_CAPABILITY, validateRefV1Arguments, refV1Response } from './ref-invocation-v1.js';

function request(param = 'file'): any {
    const target = { viewId: 'v', viewInstanceId: 'vi', bindingVersion: 1 };
    return { type: 'VIEW_TOOL_INVOKE_REF_V1', requestId: 'r', appId: 'app', instanceId: 'i', snapshotId: 's',
        argumentMode: 'snapshot-value-v1', target,
        tool: { id: '["app","File","read"]', name: 'read', viewType: 'File', description: 'Read', isMutating: false,
            inputSchema: { type: 'object', properties: { [param]: { type: 'string',
                'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } } }, required: [param] }, targets: [target] },
        rawArgs: { [param]: 'ref', ordinary: { nested: [null, false, '数据', 3] } },
        effectiveArgs: { [param]: { text: 'historical A' }, ordinary: { nested: [null, false, '数据', 3] } },
        refSources: [{ param, refId: 'ref', kind: 'snapshot-value', refType: 'unknown', snapshotId: 's', viewId: 'v', viewInstanceId: 'vi' }] };
}
function nested(depth: number): any { let v: any = null; for (let n = 0; n < depth; n++) v = [v]; return v; }
function response(): any {
    return { type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', requestId: 'r', appId: 'app', instanceId: 'i',
        argumentMode: 'snapshot-value-v1', success: true, terminal: { phase: 'not-entered',
            result: { success: false, error: { code: 'REF_EXECUTION_UNAVAILABLE', message: 'Closed' } } } };
}
function measure(value: any): { nodes: number; depth: number; approx: number; canonical: number } {
    let nodes = 0, depth = 0, approx = 0;
    const visit = (v: any, d: number) => {
        nodes++; depth = Math.max(depth, d); approx += 2;
        if (typeof v === 'string') approx += utf8Size(v);
        else if (typeof v === 'number') approx += 24;
        else if (Array.isArray(v)) v.forEach(x => visit(x, d + 1));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { approx += utf8Size(k) + 4; visit(x, d + 1); }
    };
    visit(value, 0); return { nodes, depth, approx, canonical: utf8Size(canonicalJson(value)) };
}
function padding(bytes: number, escaped: boolean): string {
    return escaped ? '\u0000'.repeat(Math.floor(bytes / 6)) + 'x'.repeat(bytes % 6) : 'x'.repeat(bytes);
}
const expected = { requestId: 'r', appId: 'app', instanceId: 'i' };

describe('Ref v1 bounded protocol data', () => {
    it.each([-1, 0, 1])('actual terminal construction obeys whole message nodes at 32000%+i', delta => {
        const m = response(); m.terminal.phase = 'entered-returned'; m.terminal.result = { success: true, data: { values: [] } };
        m.terminal.result.data.values = Array(32000 + delta - measure(m).nodes).fill(null);
        expect(measure(m).nodes).toBe(32000 + delta);
        expect(refV1Response(request(), m.terminal) !== null).toBe(delta <= 0);
    });
    it.each([49, 50, 51])('actual terminal construction obeys whole message depth %i', depth => {
        const m = response(); m.terminal.phase = 'entered-returned'; m.terminal.result = { success: true, data: { value: nested(depth - 4) } };
        expect(measure(m).depth).toBe(depth); expect(refV1Response(request(), m.terminal) !== null).toBe(depth <= 50);
    });
    it.each(['approx', 'canonical'] as const)('actual terminal construction keeps independent %s N-1/N/N+1', metric => {
        for (const delta of [-1, 0, 1]) {
            const m = response(); m.terminal.phase = 'entered-returned'; m.terminal.result = { success: true, data: { numbers: Array(100).fill(0), pad: '' } };
            m.terminal.result.data.pad = padding(524288 + delta - measure(m)[metric], metric === 'canonical');
            expect(measure(m)[metric]).toBe(524288 + delta);
            expect(refV1Response(request(), m.terminal) !== null).toBe(delta <= 0);
        }
    });
    it.each(['file', '__proto__', 'constructor', 'toJSON', ''])('preserves ordinary fields and special slot %s', param => {
        const captured = captureRefV1Request(request(param));
        expect(validateRefV1Arguments(captured)).toEqual({ success: true });
        expect(Object.isFrozen(captured.rawArgs)).toBe(true);
        expect(Object.getPrototypeOf(captured.rawArgs)).toBeNull();
    });
    it.each([
        (m: any) => m.effectiveArgs.ordinary.nested.push(4),
        (m: any) => m.effectiveArgs.extra = true,
        (m: any) => delete m.effectiveArgs.ordinary,
        (m: any) => { m.effectiveArgs.ordinary = null; },
        (m: any) => { m.rawArgs.file = ''; },
        (m: any) => { m.rawArgs.file = { marker: 'fake' }; },
        (m: any) => { m.effectiveArgs.file = []; },
        (m: any) => { m.effectiveArgs.file = null; },
        (m: any) => { m.refSources = []; },
        (m: any) => { m.refSources.push(m.refSources[0]); },
        ...['param', 'refId', 'kind', 'snapshotId', 'viewId', 'viewInstanceId'].map(key => (m: any) => m.refSources[0][key] = 'wrong'),
        (m: any) => { m.refSources[0].payload = {}; },
    ])('rejects changed correspondence %#', change => {
        const m = request(); change(m);
        expect(validateRefV1Arguments(captureRefV1Request(m))).toMatchObject({ success: false, error: { code: 'OPERATION_INVALID_ARGS' } });
    });
    it('compares ordinary key presence even for __proto__ and permits whitespace in exact Ref IDs', () => {
        const m = request(); m.rawArgs.file = m.refSources[0].refId = ' ref ';
        Object.defineProperty(m.rawArgs, '__proto__', { value: false, enumerable: true });
        Object.defineProperty(m.effectiveArgs, '__proto__', { value: false, enumerable: true });
        expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(true);
        // The property above is deliberately non-configurable; change a copied candidate.
        const altered = JSON.parse(JSON.stringify(m)); altered.effectiveArgs = { file: {}, ordinary: m.rawArgs.ordinary, other: false };
        expect(validateRefV1Arguments(captureRefV1Request(altered)).success).toBe(false);
    });
    it('requires business refType only when declared', () => {
        const m = request(); m.tool.inputSchema.properties.file['x-aotui-ref'].refType = 'File';
        expect(validateRefV1Arguments(captureRefV1Request(m))).toMatchObject({ error: { code: 'REF_TYPE_MISMATCH' } });
        m.refSources[0].refType = 'File';
        expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(true);
    });
    it.each(['zero', 'optional', 'multi', 'nested', 'version'])('checks declaration subset %s', kind => {
        const m = request(); const schema = m.tool.inputSchema;
        if (kind === 'zero') delete schema.properties.file['x-aotui-ref'];
        if (kind === 'optional') schema.required = [];
        if (kind === 'multi') schema.properties.other = schema.properties.file;
        if (kind === 'nested') { schema.properties.file = { type: 'object', properties: { inner: schema.properties.file } }; }
        if (kind === 'version') schema.properties.file['x-aotui-ref'].version = 2;
        expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(false);
    });
    it('does not execute getters or leak thrown sentinel', () => {
        let reads = 0; const m = request();
        Object.defineProperty(m.rawArgs, 'secret', { enumerable: true, get() { reads++; throw new Error('SENTINEL'); } });
        expect(() => captureRefV1Request(m)).toThrow(); expect(reads).toBe(0);
        const terminal = response(); Object.defineProperty(terminal.terminal.result, 'data', { enumerable: true, get() { reads++; return {}; } });
        expect(captureRefV1Terminal(terminal, expected)).toBeNull(); expect(reads).toBe(0);
    });
    it.each([49, 50, 51])('counts complete message depth %i', depth => {
        const v = nested(depth);
        if (depth <= 50) expect(() => captureRefV1Json(v)).not.toThrow(); else expect(() => captureRefV1Json(v)).toThrow();
    });
    it.each([31_999, 32_000, 32_001])('counts complete message nodes %i', nodes => {
        const v = Array(nodes - 1).fill(null);
        if (nodes <= 32_000) expect(() => captureRefV1Json(v)).not.toThrow(); else expect(() => captureRefV1Json(v)).toThrow();
    });
    it.each([524_287, 524_288, 524_289])('independently bounds approx bytes %i', bytes => {
        const v = Array(10_000).fill(0); v.push('x'.repeat(bytes - 260_004));
        // 10,000 finite numbers cost 26 approx bytes each; their canonical form is smaller.
        expect(utf8Size(canonicalJson(v))).toBeLessThan(524_288);
        if (bytes <= 524_288) expect(() => captureRefV1Json(v)).not.toThrow(); else expect(() => captureRefV1Json(v)).toThrow();
    });
    it.each([524_287, 524_288, 524_289])('independently bounds canonical bytes %i', bytes => {
        const v = '\u0000'.repeat(Math.floor((bytes - 2) / 6)) + 'x'.repeat((bytes - 2) % 6);
        expect(utf8Size(canonicalJson(v))).toBe(bytes);
        if (bytes <= 524_288) expect(() => captureRefV1Json(v)).not.toThrow(); else expect(() => captureRefV1Json(v)).toThrow();
    });
    it.each([23, 24, 25])('keeps the raw/effective sub-profile depth %i', depth => {
        const m = request(); m.rawArgs.ordinary = m.effectiveArgs.ordinary = nested(depth - 1);
        expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(depth <= 24);
    });
    it.each([9_999, 10_000, 10_001])('keeps raw/effective sub-profile nodes %i', nodes => {
        const m = request(); m.rawArgs = { file: 'ref', ordinary: Array(nodes - 3).fill(null) };
        m.effectiveArgs = { file: {}, ordinary: Array(nodes - 3).fill(null) };
        expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(nodes <= 10_000);
    });
    it('includes combined raw/effective, Schema, targets and metadata overhead', () => {
        const m = request(); m.rawArgs.ordinary = m.effectiveArgs.ordinary = 'x'.repeat(120_000);
        // Each args is valid alone, while the repeated target inventory exceeds the whole cap.
        m.tool.targets = Array.from({ length: 200 }, (_, i) => ({ ...m.target, viewId: 'v' + i + 'x'.repeat(1600) }));
        expect(() => captureRefV1Request(m)).toThrow();
        m.tool.targets = [m.target];
        expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(true);
        m.tool.inputSchema.properties.huge = { description: 'x'.repeat(128 * 1024) };
        expect(() => captureRefV1Request(m)).toThrow();
        expect(REF_V1_MESSAGE_LIMITS.maxDepth).toBe(50);
    });
    it.each([undefined, [], [REF_V1_CAPABILITY], ['view-tool-ref-invoke/v2']])('captures bounded capability shape %#', v => {
        expect(captureRefCapabilities(v)).not.toBeNull();
    });
    it.each([null, 'v1', [false], Array(17).fill('v'), ['x', 'x'], ['x'.repeat(129)]])('rejects capability shape %#', v => {
        expect(captureRefCapabilities(v)).toBeNull();
    });
    it.each([15, 16, 17])('bounds capability list count %i independently', count => {
        expect(captureRefCapabilities(Array.from({ length: count }, (_, i) => 'cap-' + i)) !== null).toBe(count <= 16);
    });
    it.each([127, 128, 129])('bounds one capability name length %i independently', length => {
        expect(captureRefCapabilities(['x'.repeat(length)]) !== null).toBe(length <= 128);
    });
    it('does not read a capability element getter', () => {
        let reads = 0; const list = ['v1'];
        Object.defineProperty(list, '0', { enumerable: true, get() { reads++; throw new Error('SENTINEL'); } });
        expect(captureRefCapabilities(list)).toBeNull(); expect(reads).toBe(0);
    });
    it.each([-1, 0, 1])('bounds capability canonical bytes at 1024%+i with all other limits satisfied', delta => {
        const list = ['a', 'b', 'c'].map(key => key + '界'.repeat(112));
        list[2] += 'x'.repeat(3 + delta);
        expect(measure(list).canonical).toBe(1024 + delta);
        expect(measure(list).approx).toBe(1022 + delta);
        expect(captureRefCapabilities(list) !== null).toBe(delta <= 0);
    });
    it.each(['type', 'requestId', 'appId', 'instanceId', 'argumentMode', 'success', 'phase', 'false-not-entered'])('rejects terminal mismatch %s', key => {
        const m = response();
        if (key === 'phase') m.terminal.phase = 'maybe-entered';
        else if (key === 'false-not-entered') m.terminal.result.success = true;
        else m[key] = key === 'success' ? false : 'wrong';
        expect(captureRefV1Terminal(m, expected)).toBeNull();
    });
    it('preserves a trusted entered-returned business false verbatim', () => {
        const m = response(); m.terminal.phase = 'entered-returned';
        m.terminal.result = { success: false, data: { receipt: 2 }, error: { code: 'BUSINESS_FAILED', message: 'Expected', context: { a: 1 } } };
        expect(captureRefV1Terminal(m, expected)).toEqual(m.terminal);
    });
    it.each([-1, 0, 1])('counts terminal envelope canonical bytes, N%+i', delta => {
        const m = response(); m.terminal.phase = 'entered-returned'; m.terminal.result = { success: true, data: { text: '' } };
        const overhead = utf8Size(canonicalJson(m)); const bytes = 524_288 + delta;
        const n = bytes - overhead;
        m.terminal.result.data.text = '\u0000'.repeat(Math.floor(n / 6)) + 'x'.repeat(n % 6);
        expect(utf8Size(canonicalJson(m))).toBe(bytes);
        expect(captureRefV1Terminal(m, expected) !== null).toBe(delta <= 0);
    });
    it.each([-1, 0, 1])('counts genuine request root nodes at 32000%+i', delta => {
        const m = request();
        m.rawArgs = { file: 'ref', ordinary: Array(9997).fill(null) };
        m.effectiveArgs = { file: {}, ordinary: Array(9997).fill(null) };
        m.tool.targets = Array.from({ length: 1000 }, (_, i) => ({ ...m.target, viewId: i === 0 ? 'v' : 'v' + i,
            viewInstanceId: i === 0 ? 'vi' : 'vi' + i }));
        m.tool.inputSchema.properties.ordinary = { type: 'array', examples: [] };
        m.tool.inputSchema.properties.ordinary.examples = Array(32_000 + delta - measure(m).nodes).fill(null);
        expect(measure(m).nodes).toBe(32_000 + delta);
        expect(measure(m.tool.inputSchema).nodes).toBeLessThan(10_000);
        if (delta > 0) expect(() => captureRefV1Request(m)).toThrow();
        else expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(true);
    });
    it.each([-1, 0, 1])('counts genuine terminal root nodes at 32000%+i', delta => {
        const m = response(); m.terminal.phase = 'entered-returned'; m.terminal.result = { success: true, data: { values: [] } };
        m.terminal.result.data.values = Array(32_000 + delta - measure(m).nodes).fill(null);
        expect(measure(m).nodes).toBe(32_000 + delta);
        expect(captureRefV1Terminal(m, expected) !== null).toBe(delta <= 0);
    });
    it.each([49, 50, 51])('counts genuine terminal depth %i', depth => {
        const m = response(); m.terminal.phase = 'entered-returned';
        m.terminal.result = { success: true, data: { value: nested(depth - 4) } };
        expect(measure(m).depth).toBe(depth);
        expect(captureRefV1Terminal(m, expected) !== null).toBe(depth <= 50);
    });
    it('demonstrates reachable request depth 49 under registration depth 48 (50/51 are unreachable)', () => {
        const m = request(); m.tool.inputSchema.properties.other = { examples: nested(44) };
        // request...properties.other.examples root = 5; spec root = 4.
        expect(measure(m).depth).toBe(49);
        expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(true);
        m.tool.inputSchema.properties.other.examples = nested(45);
        expect(measure(m).depth).toBe(50);
        expect(() => captureRefV1Request(m)).toThrow(); // smaller existing spec profile, not whole-message depth
    });
    it.each(['approx', 'canonical'] as const)('bounds complete request %s bytes including long unselected target metadata', metric => {
        for (const delta of [-1, 0, 1]) {
            const m = request(); m.rawArgs.other = m.effectiveArgs.other = Array(100).fill(0);
            m.tool.targets.push({ ...m.target, viewId: '' });
            const bytes = 524_288 + delta;
            m.tool.targets[1].viewId = padding(bytes - measure(m)[metric], metric === 'canonical');
            expect(measure(m)[metric]).toBe(bytes);
            expect(measure(m)[metric === 'canonical' ? 'approx' : 'canonical']).toBeLessThan(524_288);
            if (delta > 0) expect(() => captureRefV1Request(m)).toThrow();
            else expect(validateRefV1Arguments(captureRefV1Request(m)).success).toBe(true);
        }
    });
    it.each(['approx', 'canonical'] as const)('bounds terminal %s bytes with envelope overhead', metric => {
        for (const delta of [-1, 0, 1]) {
            const m = response(); m.terminal.phase = 'entered-returned';
            m.terminal.result = { success: true, data: { numbers: Array(100).fill(0), pad: '' } };
            m.terminal.result.data.pad = padding(524_288 + delta - measure(m)[metric], metric === 'canonical');
            expect(measure(m)[metric]).toBe(524_288 + delta);
            expect(captureRefV1Terminal(m, expected) !== null).toBe(delta <= 0);
        }
    });
    it.each(['raw', 'effective'])('enforces independent %s args approx and canonical N-1/N/N+1', which => {
        for (const metric of ['approx', 'canonical'] as const) for (const delta of [-1, 0, 1]) {
            const m = request();
            if (which === 'raw') {
                m.rawArgs = { file: 'ref', numbers: Array(100).fill(0), pad: '' };
                const fill = padding(131_072 + delta - measure(m.rawArgs)[metric], metric === 'canonical');
                m.rawArgs.pad = fill; m.effectiveArgs = { ...m.rawArgs, file: {} };
            } else {
                m.effectiveArgs = { ...m.rawArgs, file: { numbers: Array(100).fill(0), pad: '' } };
                m.effectiveArgs.file.pad = padding(131_072 + delta - measure(m.effectiveArgs)[metric], metric === 'canonical');
            }
            expect(measure(which === 'raw' ? m.rawArgs : m.effectiveArgs)[metric]).toBe(131_072 + delta);
            const result = validateRefV1Arguments(captureRefV1Request(m));
            expect(result.success).toBe(delta <= 0);
            if (delta > 0) expect(result.error?.code).toBe(which === 'raw' ? 'OPERATION_INVALID_ARGS' : 'REF_ARGUMENT_BUDGET_EXCEEDED');
        }
    });
    it.each(['approx', 'canonical'] as const)('counts preparation envelope %s bytes separately from args and IPC', metric => {
        for (const delta of [-1, 0, 1]) {
            const m = request(); m.rawArgs.numbers = m.effectiveArgs.numbers = Array(100).fill(0);
            m.effectiveArgs.file = { pad: '' };
            const envelope = () => ({ source: { appId: m.appId, instanceId: m.instanceId,
                snapshotId: m.snapshotId, toolId: m.tool.id, viewId: m.target.viewId,
                viewInstanceId: m.target.viewInstanceId, bindingVersion: m.target.bindingVersion },
                effectiveArgs: m.effectiveArgs, refSources: m.refSources });
            const remaining = 139_264 + delta - measure(envelope())[metric];
            const extra = Math.floor(remaining / 2);
            const fill = padding(extra, metric === 'canonical');
            m.snapshotId += fill; m.refSources[0].snapshotId += fill;
            m.effectiveArgs.file.pad = 'x'.repeat(remaining % 2);
            expect(measure(envelope())[metric]).toBe(139_264 + delta);
            const result = validateRefV1Arguments(captureRefV1Request(m));
            expect(result.success).toBe(delta <= 0);
            if (delta > 0) expect(result.error?.code).toBe('REF_ARGUMENT_BUDGET_EXCEEDED');
        }
    });
});
