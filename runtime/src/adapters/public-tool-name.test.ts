import { describe, expect, it } from 'vitest';
import type { Observation } from '@aotui/core';
import { buildPublicToolName, DESKTOP_TOOL_NAMES, projectNativeToolNames } from './public-tool-name.js';

function observation(appId: string, ...pairs: [viewType: string, name: string][]): Pick<Observation, 'source' | 'tools'> {
    return { source: { appId, revision: 1, instanceId: 'run', snapshotId: 'snapshot' }, tools: pairs.map(([viewType, name]) => ({
        id: JSON.stringify([appId, viewType, name]), viewType, name, description: name, multiplicity: 'multiple',
        inputSchema: { type: 'object', properties: {}, required: [] },
    })) };
}

describe('fixed public Tool names', () => {
    it('uses three unambiguous components and reserves system controls separately', () => {
        expect(buildPublicToolName('system_ide', 'FileDetail', 'edit_file')).toBe('system_ide-FileDetail-edit_file');
        expect(buildPublicToolName('demo', 'A_B', 'C')).not.toBe(buildPublicToolName('demo', 'A', 'B_C'));
        expect(buildPublicToolName('system', 'Editor', 'open_app')).toBe('system-Editor-open_app');
        expect(Object.values(DESKTOP_TOOL_NAMES)).not.toContain('system-Editor-open_app');
    });

    it.each(['appName', 'viewType', 'toolName'] as const)('rejects invalid %s without rewriting it', field => {
        const index = ['appName', 'viewType', 'toolName'].indexOf(field);
        for (const invalid of ['', 'bad-app', 'has space', '名字', 'has/slash']) {
            const args: [string, string, string] = ['valid', 'View', 'Tool'];
            args[index] = invalid;
            expect(() => buildPublicToolName(...args)).toThrow(expect.objectContaining({
                code: 'AOTUI_TOOL_NAME_INVALID', path: field,
            }));
        }
    });
    it.each([63, 64])('accepts complete native names of %i characters', length => {
        expect(buildPublicToolName('a', 'b', 'x'.repeat(length - 4))).toHaveLength(length);
    });
    it('rejects a complete native name over 64 characters', () => {
        expect(() => buildPublicToolName('a', 'b', 'x'.repeat(61))).toThrow(expect.objectContaining({
            code: 'AOTUI_TOOL_NAME_INVALID', path: 'publicToolName',
            message: expect.stringContaining('65 characters'),
        }));
    });
    it('keeps a declaration name when a same-named declaration appears or disappears', () => {
        for (const pairs of [[['Editor', 'save']], [['Editor', 'save'], ['Search', 'save']], [['Editor', 'save']]] as [string,string][][]) {
            const source = observation('workspace', ...pairs);
            const [first, second] = projectNativeToolNames([source, observation('workspace_1', ['Editor', 'save'])]);
            expect(first).toMatchObject({ status: 'ready' });
            expect(second).toMatchObject({ status: 'ready' });
            if (first?.status !== 'ready' || second?.status !== 'ready') throw Error('Expected named tools');
            expect(first.tools.get('workspace-Editor-save')).toBe(source.tools[0]);
            expect(second.tools.has('workspace_1-Editor-save')).toBe(true);
            expect(first.tools.size).toBe(pairs.length);
        }
    });
    it('rejects both contradictory namespaces and duplicate routes, retaining valid peers and exact diagnostics', () => {
        const healthy = observation('healthy', ['Inbox', 'read']);
        const tooLong = observation('archive', ['List', 'x'.repeat(65)]);
        const conflict = observation('notes', ['Archive', 'read']);
        const duplicate = observation('duplicates', ['Inbox', 'read'], ['Inbox', 'read']);
        const duplicateId = observation('ids', ['Inbox', 'read'], ['Inbox', 'save']);
        const repeatedIdentity = { ...duplicateId, tools: [duplicateId.tools[0]!, { ...duplicateId.tools[1]!, id: duplicateId.tools[0]!.id }] };
        expect(projectNativeToolNames([healthy, tooLong, conflict, observation('notes', ['Other', 'open']), duplicate, repeatedIdentity])).toMatchObject([
            { status: 'ready', tools: new Map([['healthy-Inbox-read', healthy.tools[0]]]) },
            { status: 'ready', tools: new Map(), excluded: [{ code: 'AOTUI_TOOL_NAME_INVALID', path: 'publicToolName', toolId: tooLong.tools[0]!.id }] },
            ...Array.from({ length: 4 }, () => ({ status: 'rejected', issue: { code: 'AOTUI_TOOL_NAME_COLLISION', path: 'publicToolName' } })),
        ]);
    });
});
