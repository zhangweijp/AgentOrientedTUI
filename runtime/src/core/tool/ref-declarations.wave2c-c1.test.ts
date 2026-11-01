import { describe, expect, it, vi } from 'vitest';
import { copyJson } from '../snapshot/json.js';
import { validatePreparedV2Draft } from '../snapshot/v2-validator.js';
import type { JsonValue } from '../snapshot/types.js';
import { validateToolRefDeclarations } from './ref-declarations.js';
import { createViewOwnedTools } from './view-owned-tools.js';

const marker = { version: 1, kind: 'snapshot-value', owner: 'tool-target' };
const declared = { type: 'string', 'x-aotui-ref': marker };
const literalNames = ['default', 'const', 'enum', 'examples'];

async function inspect(inputSchema: JsonValue, args: Readonly<Record<string, unknown>> = {}) {
    let semantic: boolean | string;
    try {
        semantic = validateToolRefDeclarations(copyJson(inputSchema, {
            maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024,
        }), false);
    } catch (error) {
        semantic = (error as { code: string }).code;
    }
    const registry = createViewOwnedTools('app', 'run');
    const view = registry.mount('fd_A', 'FileDetail');
    const id = JSON.stringify(['app', 'FileDetail', 'inspect']);
    const validation = validatePreparedV2Draft({
        schemaVersion: 2, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ id: 'fd_A', viewInstanceId: view.viewInstanceId, type: 'FileDetail', name: 'A', kind: 'state',
            content: { format: 'markdown-v1', value: 'A' } }], refs: {}, tools: {
            [id]: { id, name: 'inspect', viewType: 'FileDetail', description: 'Inspect', inputSchema, isMutating: false,
                targets: [{ viewId: 'fd_A', viewInstanceId: view.viewInstanceId, bindingVersion: 1 }] },
        },
    });
    const handler = vi.fn(async (received: Readonly<Record<string, unknown>>) => ({
        success: true, data: { identity: 'fd_A', args: received },
    }));
    let registration = 'accepted';
    try {
        registry.registerTool(view.viewInstanceId, { name: 'inspect', description: 'Inspect', inputSchema, isMutating: false }, handler);
    } catch (error) {
        registration = (error as { code: string }).code;
    }
    const tool = registry.listTools()[0];
    return {
        semantic, snapshot: validation.ok ? 'accepted' : validation.issue.code,
        registration, handlerCalls: handler.mock.calls.length, registeredSchema: tool?.inputSchema,
    };
}

describe('Wave 2C C1: Schema nodes, member-name maps and literal data', () => {
    it.each(['ordinary', ...literalNames])('rejects a misplaced declaration under dependencies member %s', async name => {
        const result = await inspect({ type: 'object', properties: {
            file: { type: 'string' }, [name]: { type: 'boolean' },
        }, dependencies: {
            [name]: { type: 'object', properties: { file: declared } },
        } }, { file: 'file', [name]: true });
        expect(result).toMatchObject({
            semantic: 'REF_DECLARATION_INVALID', snapshot: 'REF_DECLARATION_INVALID',
            registration: 'REF_DECLARATION_INVALID', handlerCalls: 0,
        });
    });

    it.each(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas'])(
        'continues to traverse %s members whose names resemble keywords or the annotation', async keyword => {
            for (const name of [...literalNames, 'x-aotui-ref']) {
                expect(await inspect({ type: 'object', [keyword]: {
                    [name]: { type: 'object', properties: { file: declared } },
                } })).toMatchObject({
                    semantic: 'REF_DECLARATION_INVALID', snapshot: 'REF_DECLARATION_INVALID',
                    registration: 'REF_DECLARATION_INVALID', handlerCalls: 0,
                });
            }
        },
    );

    it.each(['dependencies', 'dependentRequired'])('keeps ordinary property dependency names in %s as data', async keyword => {
        const args = { 'x-aotui-ref': true, file: 'file' };
        const result = await inspect({ type: 'object', properties: {
            'x-aotui-ref': { type: 'boolean' }, file: { type: 'string' },
        }, [keyword]: { 'x-aotui-ref': ['file'] } }, args);
        expect(result).toMatchObject({
            semantic: false, snapshot: 'accepted', registration: 'accepted', handlerCalls: 0,
        });
    });

    it('keeps a plain Schema dependency named x-aotui-ref as a Schema, not annotation metadata', async () => {
        expect(await inspect({ type: 'object', dependencies: {
            'x-aotui-ref': { type: 'object', properties: { file: { type: 'string' } } },
        } })).toMatchObject({ semantic: false, snapshot: 'accepted', registration: 'accepted', handlerCalls: 0 });
    });

    it.each([true, false])('keeps the boolean dependency Schema %s', async dependency => {
        expect(await inspect({ type: 'object', dependencies: { 'x-aotui-ref': dependency } }))
            .toMatchObject({ semantic: false, snapshot: 'accepted', registration: 'accepted', handlerCalls: 0 });
    });

    it.each(literalNames)('does not inspect real %s literal data for Ref declarations', async keyword => {
        const payload = { 'x-aotui-ref': { version: 99 }, dependencies: { default: declared } };
        const args = { file: payload };
        expect(await inspect({ type: 'object', properties: { file: {
            type: 'object', [keyword]: keyword === 'enum' || keyword === 'examples' ? [payload] : payload,
        } } }, args)).toMatchObject({
            semantic: false, snapshot: 'accepted', registration: 'accepted', handlerCalls: 0,
        });
    });

    it.each(['file', ...literalNames, 'x-aotui-ref'])(
        'retains the legal top-level declaration for parameter %s and still refuses execution', async name => {
            const inputSchema = { type: 'object', properties: { [name]: declared } };
            expect(await inspect(inputSchema)).toMatchObject({
                semantic: true, snapshot: 'accepted', registration: 'accepted', registeredSchema: inputSchema,
                handlerCalls: 0,
            });
        },
    );

    it('keeps an ordinary parameter named x-aotui-ref unannotated', async () => {
        expect(await inspect({ type: 'object', properties: { 'x-aotui-ref': { type: 'string' } } },
            { 'x-aotui-ref': '[File](file)' })).toMatchObject({
            semantic: false, snapshot: 'accepted', registration: 'accepted', handlerCalls: 0,
        });
    });
});
