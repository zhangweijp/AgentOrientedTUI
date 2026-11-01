import { describe, expect, it } from 'vitest';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { createViewOwnedTools } from './view-owned-tools.js';
import { compileOrdinaryParams } from './ordinary-parameter-contract.js';
import { compileOrdinaryProfile, ORDINARY_PARAMETER_MARKER as MARKER } from './ordinary-parameter-profile.js';
import { validateToolRefDeclarations } from './ref-declarations.js';
import { compileSnapshotValueParams as params, compileSnapshotValueProfile as profile,
    type SnapshotValueCompileResult, type SnapshotValueParameterContract } from './snapshot-value-parameter-contract.js';

const ref = { type: 'reference', required: true, refSource: 'snapshot-value-v1' };
const ordinary = {
    choice: { type: 'enum', options: ['7', 'ok'] },
    text: { type: 'string', constraints: { maxLength: 1, pattern: '^.$' } },
    tags: { type: 'array', itemType: 'string', constraints: { minLength: 1, maxLength: 2 } },
    n: { type: 'number', constraints: { min: 1, max: 3 }, default: 2 },
    yes: { type: 'boolean' }, meta: { type: 'object' },
};
const declared = () => ({ file: { ...ref }, ...ordinary });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function success(x: SnapshotValueCompileResult): SnapshotValueParameterContract {
    expect(x.ok).toBe(true); if (!x.ok) throw Error(x.issue.code); return x.contract;
}
function rejected(x: SnapshotValueCompileResult, code?: string) {
    expect(x.ok).toBe(false); if (x.ok) throw Error('Expected rejection');
    expect(x.issue.code).toBe(code ?? x.issue.code); expect(Object.isFrozen(x)).toBe(true);expect(Object.isFrozen(x.issue)).toBe(true);
    return x.issue;
}
function frozen(x: unknown): void {
    if (x !== null && typeof x === 'object') { expect(Object.isFrozen(x)).toBe(true); Object.values(x).forEach(frozen); }
}
function nested(depth: number): JsonValue { let v: JsonValue = null; for (let i = 0; i < depth; i++) v = { v }; return v; }
function assertBoth(c: SnapshotValueParameterContract, fields: Record<string, unknown>, ok: boolean) {
    for (const result of [c.validateRaw({ file: 'id', ...fields }), c.validateEffective({ file: {}, ...fields })]) {
        expect(result.ok).toBe(ok);frozen(result);if (!result.ok) expect(result.code).toBe('PARAMETER_INPUT_INVALID');
    }
}

describe('P01: DSL/profile round trip and complete stages', () => {
    it('uses one captured B1 rule set with an explicit Ref profile and identical frontends', () => {
        const c = success(params(declared(), { additionalProperties: false })), p = success(profile(c.schema));
        expect(c.revision).toBe('snapshot-value-params-v1');expect(c.schema[MARKER]).toBe(c.revision);
        expect(c.ref).toEqual({ param: 'file' });expect(p.fingerprint).toBe(c.fingerprint);
        expect(c.fingerprint).toBe(canonicalJson({ revision: c.revision, schema: c.schema }));frozen(c);
        for (const stage of ['validateRaw', 'validateEffective'] as const) {
            const input = { file: stage === 'validateRaw' ? 'id' : { opaque: [true, null] }, choice: 'ok', tags: ['x'], text: 'a', n: 3, yes: true, meta: {} };
            expect(p[stage](input)).toEqual(c[stage](input));expect(c[stage](input).ok).toBe(true);
        }
        expect((c.schema.properties as Record<string, JsonValue>).tags).toEqual({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 });
    });
    it('supports only a Ref, and retains explicit refType and its whitespace', () => {
        for (const field of [ref, { ...ref, refType: ' File ', desc: 'Original state' }]) {
            const c = success(params({ file: field }));expect(success(profile(c.schema)).fingerprint).toBe(c.fingerprint);
            expect(c.validateRaw({ file: ' ' }).ok).toBe(true);expect(c.validateEffective({ file: {} }).ok).toBe(true);
            if ('refType' in field) expect(c.ref.refType).toBe(' File ');
        }
    });
});

describe('P02: exactly one required top-level C1 Ref', () => {
    it.each([
        ['none', { x: { type: 'string' } }], ['two', { file: ref, other: ref }],
        ['optional', { file: { ...ref, required: false } }], ['missing required', { file: { type: 'reference', refSource: 'snapshot-value-v1' } }],
        ['missing source', { file: { type: 'reference', required: true } }], ['wrong source', { file: { ...ref, refSource: 'OTHER' } }],
        ['blank refType', { file: { ...ref, refType: ' ' } }], ['numeric refType', { file: { ...ref, refType: 2 } }],
        ['extra default', { file: { ...ref, default: 'id' } }], ['extra constraints', { file: { ...ref, constraints: {} } }],
        ['nested', { file: ref, nested: { type: 'object', properties: { file: ref } } }],
    ])('rejects DSL %s', (_, input) => rejected(params(input)));
    it.each(['kind', 'owner', 'version', 'refType'])('rejects unsupported or malformed profile metadata %s', key => {
        const s = clone(success(params({ file: ref })).schema) as any;
        s.properties.file['x-aotui-ref'][key] = key === 'version' ? 2 : key === 'refType' ? '' : 'OTHER';
        rejected(profile(s), key === 'refType' ? 'PARAMETER_DECLARATION_INVALID' : 'PARAMETER_DECLARATION_UNSUPPORTED');
    });
    it.each(['none', 'optional', 'multiple', 'nested', 'constraint', 'default'])('rejects profile Ref shape %s', kind => {
        const s = clone(success(params({ file: ref })).schema) as any;
        if (kind === 'none') { delete s.properties.file; s.required = []; }
        if (kind === 'optional') s.required = [];
        if (kind === 'multiple') { s.properties.other = clone(s.properties.file); s.required.push('other'); }
        if (kind === 'nested') s.properties.nested = { type: 'object', properties: { ref: clone(s.properties.file) } };
        if (kind === 'constraint') s.properties.file.minLength = 1;
        if (kind === 'default') s.properties.file.default = 'id';
        rejected(profile(s));
    });
});

describe('P03: existing B1 ordinary semantics, no second field validator', () => {
    const c = success(params(declared(), { additionalProperties: false }));
    it.each([
        [{ choice: '7' }, true], [{ choice: 7 }, false], [{ choice: 'other' }, false],
        [{ text: '😀' }, false], // The JS RegExp ^.$ does not use the Unicode flag.
        [{ tags: ['x'] }, true], [{ tags: [] }, false], [{ tags: ['a', 'b', 'c'] }, false], [{ tags: [1] }, false],
        [{ n: 1 }, true], [{ n: 3 }, true], [{ n: 0 }, false], [{ n: Infinity }, false],
        [{ yes: true }, true], [{ yes: 'true' }, false], [{ meta: {} }, true], [{ meta: null }, false], [{ extra: true }, false],
    ])('validates both stages for %j', (input, ok) => {
        assertBoth(c, input, ok);
        const b1 = compileOrdinaryParams(ordinary, { additionalProperties: false });
        if (!b1.ok) throw Error('B1 fixture');expect(b1.contract.validate(input).ok).toBe(ok);
    });
    it('counts code points, validates required, keeps unknown fields only when open, and never fills defaults', () => {
        const c = success(params({ file: ref, text: { type: 'string', constraints: { maxLength: 1 } }, n: { type: 'number', default: 2 } }));
        assertBoth(c, { text: '😀', extra: { x: true } }, true);
        const v = c.validateRaw({ file: 'id' });expect(v.ok && Object.hasOwn(v.value, 'n')).toBe(false);
        assertBoth(success(params({ file: ref, x: { type: 'number', required: true } })), {}, false);
    });
    it.each([
        { text: { type: 'string', constraints: { pattern: '[' } } },
        { x: { type: 'number', default: 'bad' } }, { x: { type: 'string', constraints: { minLength: 3, maxLength: 2 } } },
    ])('rejects invalid annotations and rules %j', fields => rejected(params({ file: ref, ...fields }), 'PARAMETER_DECLARATION_INVALID'));
});

describe('P04: two stages preserve complete detached values', () => {
    it.each([null, [], 'id', 7, true])('rejects effective Ref %j', file => expect(success(params({ file: ref })).validateEffective({ file }).ok).toBe(false));
    it.each(['', {}, null, [], 7, true])('rejects raw Ref %j', file => expect(success(params({ file: ref })).validateRaw({ file }).ok).toBe(false));
    it('keeps opaque payload and all keys without resolving or trimming', () => {
        const c = success(params({ file: { ...ref, refType: 'File' } })), input = { file: { arbitrary: [null, 1, true, { x: 'value' }] }, extra: { x: 1 } };
        const v = c.validateEffective(input);expect(v.ok).toBe(true);if (!v.ok) return;
        expect(v.value).toEqual(input);expect(v.value).not.toBe(input);frozen(v);input.file.arbitrary[0] = 2;
        expect((v.value.file as any).arbitrary[0]).toBe(null);
        const raw = c.validateRaw({ file: ' id ' });expect(raw.ok && raw.value.file).toBe(' id ');
    });
});

describe('P05: exact marker and normalized closed vocabulary', () => {
    it.each([undefined, 'ordinary-params-v1', 'OTHER', null, 1])('does not upgrade marker %j', marker => {
        const s = clone(success(params({ file: ref })).schema) as any;if (marker === undefined) delete s[MARKER];else s[MARKER] = marker;
        rejected(profile(s), 'PARAMETER_DECLARATION_UNSUPPORTED');
    });
    it.each(['additionalProperties', 'duplicate required', 'required order', 'extra root', 'extra field'])('rejects noncanonical profile %s', change => {
        const s = clone(success(params({ file: ref, z: { type: 'string', required: true } })).schema) as any;
        if (change === 'additionalProperties') delete s.additionalProperties;
        if (change === 'duplicate required') s.required.push('file');
        if (change === 'required order') s.required.reverse();
        if (change === 'extra root') s.title = 'unknown';
        if (change === 'extra field') s.properties.z.transform = 'unknown';
        rejected(profile(s));
    });
    it.each([null, { additionalProperties: 'yes' }, { unknown: true }])('rejects invalid options %j', options => rejected(params({ file: ref }, options as any)));
});

describe('P06: full canonical identity', () => {
    it('ignores insertion order, while every declared rule and Ref identity participates', () => {
        const base = { file: { ...ref, desc: 'Ref', refType: 'File' }, x: { type: 'number', default: 1 } };
        const c = success(params(base));expect(success(params({ x: base.x, file: base.file })).fingerprint).toBe(c.fingerprint);
        const variants = [
            { ...base, file: { ...base.file, desc: 'changed' } }, { ...base, file: { ...base.file, refType: 'Other' } },
            { other: base.file, x: base.x }, { ...base, x: { ...base.x, default: 2 } }, { ...base, x: { ...base.x, constraints: { min: 0 } } },
        ];
        for (const v of variants) expect(success(params(v)).fingerprint).not.toBe(c.fingerprint);
        expect(success(params(base, { additionalProperties: false })).fingerprint).not.toBe(c.fingerprint);
        const s = { ...c.schema, description: 'Root description' };expect(success(profile(s)).fingerprint).not.toBe(c.fingerprint);
        base.file.refType = 'mutated';base.x.default = 99;expect(c.ref.refType).toBe('File');expect(c.fingerprint).not.toContain('mutated');
        expect(success(profile(Object.fromEntries(Object.entries(c.schema).reverse()))).fingerprint).toBe(c.fingerprint);
    });
});

describe('P07: strict capture and literal / parameter names', () => {
    const bad = [
        () => ({ file: ref, get x() { throw Error('getter'); } }),
        () => Object.defineProperty({ file: ref }, 'hidden', { value: 1 }),
        () => ({ file: ref, [Symbol('s')]: 1 }), () => Object.assign(Object.create({ inherited: true }), { file: ref }),
        () => ({ file: ref, x: () => 1 }), () => ({ file: ref, x: { type: 'object', default: [, 1] } }),
        () => ({ file: ref, x: { type: 'number', default: NaN } }),
        () => { const x: any = { file: ref };x.cycle = x;return x; },
    ];
    it.each(bad.map((make, i) => ({ make, i })))('rejects strict JSON case $i before classification and in either complete input', ({ make }) => {
        rejected(params(make()), 'PARAMETER_DECLARATION_INVALID');
        const c = success(params({ file: ref }));expect(c.validateRaw({ file: 'id', extra: make() }).ok).toBe(false);expect(c.validateEffective({ file: make() }).ok).toBe(false);
    });
    it('reads zero getter values in DSL, options, profile, raw and effective', () => {
        let reads = 0;const accessor = () => Object.defineProperty({}, 'x', { enumerable: true, get() { reads++;return 1; } });
        rejected(params({ file: ref, x: accessor() }));rejected(params({ file: ref }, accessor()));rejected(profile(accessor()));
        const c = success(params({ file: ref }));expect(c.validateRaw(accessor()).ok).toBe(false);expect(c.validateEffective({ file: accessor() }).ok).toBe(false);expect(reads).toBe(0);
    });
    it('retains literal marker keys and special parameter names as own data', () => {
        const data = { 'x-aotui-ref': { version: 'DATA' }, [MARKER]: 'DATA', refSource: 'DATA' };
        for (const name of ['', '__proto__', 'constructor', 'line\nname']) {
            const input = Object.fromEntries([[name, { ...ref }], ['meta', { type: 'object', default: data }]]);
            const c = success(params(input));expect(c.ref.param).toBe(name);expect(success(profile(c.schema)).fingerprint).toBe(c.fingerprint);
            for (const [method, value] of [['validateRaw', 'id'], ['validateEffective', data]] as const) {
                const result = c[method](Object.fromEntries([[name, value], ['meta', data]]));expect(result.ok).toBe(true);
                if (result.ok) { expect(Object.hasOwn(result.value, name)).toBe(true);expect(Object.getPrototypeOf(result.value)).toBe(null);expect(result.value.meta).toEqual(data); }
            }
        }
        expect(({} as any).polluted).toBeUndefined();
    });
});

describe('P08: whole declaration and final public-profile budgets', () => {
    it('counts final Ref metadata and marker, not just the ordinary projection', () => {
        const c = success(params({ file: ref, x: { type: 'object' } }));const base = clone(c.schema) as any;
        const length = Math.floor((65536 - utf8Size(canonicalJson({ ...base, description: '' }))) / 6);
        expect(profile({ ...base, description: '\u0000'.repeat(length) }).ok).toBe(true);
        rejected(profile({ ...base, description: '\u0000'.repeat(length + 1) }), 'PARAMETER_DECLARATION_INVALID');
        // A DSL annotation can fit captured input yet overflow once metadata and marker are restored.
        const fields = { file: { ...ref }, meta: { type: 'object', default: { v: '' } } };
        const rawRef = { type: 'string', required: true, constraints: { minLength: 1 } };
        const raw = compileOrdinaryParams({ ...fields, file: rawRef });if (!raw.ok) throw Error('fixture');
        const maximum = Math.floor((65536 - utf8Size(canonicalJson(raw.contract.schema))) / 6);
        const boundary = { ...fields, meta: { type: 'object', default: { v: '\u0000'.repeat(maximum) } } };
        expect(utf8Size(canonicalJson(boundary))).toBeLessThanOrEqual(65536);
        expect(compileOrdinaryParams({ ...boundary, file: rawRef }).ok).toBe(true);rejected(params(boundary));
    });
    it('counts nodes in the full DSL and full normalized profile', () => {
        const input = { file: ref, meta: { type: 'object', default: { list: Array(4987).fill(null) } } };
        expect(() => copyJson(input, { maxDepth: 24, maxNodes: 5000, maxApproxBytes: 65536 })).not.toThrow();
        expect(compileOrdinaryParams({ ...input, file: { type: 'string', required: true, constraints: { minLength: 1 } } }).ok).toBe(true);
        rejected(params(input));
        rejected(params({ file: ref, meta: { type: 'object', default: nested(25) } }));
        rejected(profile({ ...success(params({ file: ref })).schema, description: '\u0000'.repeat(12000) }));
    });
    it('accepts full profile5000 nodes / depth24 and rejects the next node / level', () => {
        const count = (x: JsonValue): number => 1 + (x && typeof x === 'object' ? Object.values(x).reduce((n: number, v) => n + count(v), 0) : 0);
        const empty = success(params({ file: ref, meta: { type: 'object', default: { list: [] } } }));
        const n = 5000 - count(empty.schema);
        const atLimit = success(params({ file: ref, meta: { type: 'object', default: { list: Array(n).fill(null) } } }));
        expect(count(atLimit.schema)).toBe(5000);expect(profile(atLimit.schema).ok).toBe(true);
        rejected(params({ file: ref, meta: { type: 'object', default: { list: Array(n + 1).fill(null) } } }));
        for (const depth of [21, 22]) {
            const input = { file: ref, meta: { type: 'object', default: nested(depth) } };
            expect(() => copyJson(input, { maxDepth: 24, maxNodes: 5000, maxApproxBytes: 65536 })).not.toThrow();
            const result = params(input);expect(result.ok).toBe(depth === 21);
            if (result.ok) expect(profile(result.contract.schema).ok).toBe(true);
        }
    });
});

describe('P09: complete input capacities, including opaque Ref payload', () => {
    const c = success(params({ file: ref }));
    it('applies 10000/10001 nodes to the complete raw and effective objects', () => {
        expect(c.validateRaw({ file: 'id', x: Array(9997).fill(null) }).ok).toBe(true);
        expect(c.validateRaw({ file: 'id', x: Array(9998).fill(null) }).ok).toBe(false);
        expect(c.validateEffective({ file: { x: Array(9997).fill(null) } }).ok).toBe(true);
        expect(c.validateEffective({ file: { x: Array(9998).fill(null) } }).ok).toBe(false);
    });
    it('applies depth24/25 to the complete inputs', () => {
        for (const depth of [23, 24]) {
            expect(c.validateRaw({ file: 'id', extra: nested(depth) }).ok).toBe(depth === 23);
            expect(c.validateEffective({ file: nested(depth) }).ok).toBe(depth === 23);
        }
    });
    it('separates numeric approximate bytes from escaped canonical bytes at exact shape boundaries', () => {
        const limit = 128 * 1024;
        const fits = (input: unknown) => c.validateEffective(input).ok;
        // reserve(root2 + file8 + object2 + x5 + string2)=19 approximate; canonical has17 ASCII bytes.
        expect(fits({ file: { x: 'a'.repeat(limit - 19) } })).toBe(true);
        expect(fits({ file: { x: 'a'.repeat(limit - 18) } })).toBe(false);
        const canonicalOverhead = utf8Size(canonicalJson({ file: { x: '' } }));
        const n = Math.floor((limit - canonicalOverhead) / 6);
        expect(fits({ file: { x: '\u0000'.repeat(n) } })).toBe(true);expect(fits({ file: { x: '\u0000'.repeat(n + 1) } })).toBe(false);
        // Numeric nodes reserve26 bytes each; their short serialized form is not the governing cap.
        const numeric = (n: number) => ({ file: { x: Array(n).fill(0) } });
        const overhead = 2 + 8 + 2 + 5 + 2;
        const numbers = Math.floor((limit - overhead) / 26);
        expect(fits(numeric(numbers))).toBe(true);expect(fits(numeric(numbers + 1))).toBe(false);
    });
    it('also accounts for the complete raw Ref ID when applying both byte budgets', () => {
        const limit = 128 * 1024, raw = (v: JsonValue) => ({ file: 'id', extra: { x: v } });
        expect(c.validateRaw(raw('a'.repeat(limit - 32))).ok).toBe(true);expect(c.validateRaw(raw('a'.repeat(limit - 31))).ok).toBe(false);
        const n = Math.floor((limit - utf8Size(canonicalJson(raw('')))) / 6);
        expect(c.validateRaw(raw('\u0000'.repeat(n))).ok).toBe(true);expect(c.validateRaw(raw('\u0000'.repeat(n + 1))).ok).toBe(false);
        const numbers = Math.floor((limit - 32) / 26);
        expect(c.validateRaw(raw(Array(numbers).fill(0))).ok).toBe(true);expect(c.validateRaw(raw(Array(numbers + 1).fill(0))).ok).toBe(false);
    });
});

describe('P10: structured bounded safe errors', () => {
    it('does not echo bad values or raw exceptions and bounds B1 diagnostics', () => {
        const sentinel = 'PRIVATE_VALUE_SENTINEL';
        for (const result of [params({ file: { ...ref, refSource: sentinel } }), params({ file: ref, x: { type: 'string', constraints: { pattern: '[' + sentinel } } }), profile({ [MARKER]: sentinel })]) {
            rejected(result);expect(JSON.stringify(result)).not.toContain(sentinel);frozen(result);
        }
        const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['n'.repeat(140) + '\n' + i, { type: 'number', required: true }]));
        const c = success(params({ file: ref, ...many })), result = c.validateRaw({ file: 'id', extra: sentinel });
        expect(result.ok).toBe(false);frozen(result);if (result.ok) return;
        expect(result.diagnostics).toHaveLength(16);expect(JSON.stringify(result)).not.toContain(sentinel);
        for (const d of result.diagnostics) { expect(d.parameter?.length).toBeLessThanOrEqual(128);expect(d.parameter).not.toContain('\n'); }
    });
});

describe('P11: declarations do not grant executable entry points', () => {
    it('keeps an unqualified Ref declaration closed while Registry and Snapshot admit the exact V2 profile', async () => {
        const c = success(params({ file: ref }));expect(() => validateToolRefDeclarations(c.schema, false)).toThrow();
        expect(compileOrdinaryProfile(c.schema)).toBe(null);
        const r = createViewOwnedTools('app', 'run'), owner = r.mount('v', 'File');
        let entries = 0;
        expect(() => r.registerTool(owner.viewInstanceId, { name: 'inspect', description: 'Inspect', inputSchema: c.schema, isMutating: false }, () => { entries++;return { success: true }; })).not.toThrow();
        const declared = r.listTools()[0]!;
        expect(r.validateSnapshotValueParametersBinding(declared, declared.targets[0]!).success).toBe(false);
        expect((await r.invokeSnapshotValueParameters(declared, declared.targets[0]!, { file: {} })).phase).toBe('not-entered');
        expect(entries).toBe(0);
        const core = createSnapshotCore();core.lifecycle.startApp('app', 'run');
        const target = { viewId: 'v', viewInstanceId: 'mount', bindingVersion: 1 }, id = JSON.stringify(['app', 'File', 'inspect']);
        const tool = { id, name: 'inspect', description: 'Inspect', viewType: 'File', inputSchema: c.schema, isMutating: false, targets: [target] };
        const commit = core.committer.accept({ schemaVersion: 2, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views: [{ id: 'v', viewInstanceId: 'mount', type: 'File', name: 'V', kind: 'state', content: { format: 'markdown-v1', value: 'V' } }],
            refs: { [refKey('v', 'mount', 'id')]: { id: 'id', ownerViewId: 'v', ownerViewInstanceId: 'mount', refType: 'unknown', target: { kind: 'snapshot-value', payload: {} } } }, tools: { [id]: tool } });
        expect(commit.status).toBe('published');
    });
});
