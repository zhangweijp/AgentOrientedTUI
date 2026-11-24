import { describe, expect, it } from 'vitest';
import type { Observation } from '@aotui/core';
import { buildPublicToolName, projectNativeToolNames } from './public-tool-name.js';

function observation(appId: string, ...pairs: [viewType: string, name: string][]): Pick<Observation, 'source' | 'tools'> {
    return { source: { appId, revision: 1, instanceId: 'run', snapshotId: 'snapshot' }, tools: pairs.map(([viewType, name]) => ({
        id: JSON.stringify([appId, viewType, name]), viewType, name, description: name, multiplicity: 'single', inputSchema: { type: 'object' },
    })) };
}

describe('native public Tool names', () => {
    it('joins valid component names with an unambiguous separator', () => {
        expect(buildPublicToolName('system_ide', 'edit_file')).toBe('system_ide-edit_file');
        expect(buildPublicToolName('system_ide', 'FileDetail', 'edit_file'))
            .toBe('system_ide-FileDetail-edit_file');
        expect(buildPublicToolName('demo', 'A_B', 'C'))
            .not.toBe(buildPublicToolName('demo', 'A', 'B_C'));
    });

    it.each([
        ['appName', 'bad-app', 'valid', 'Tool'],
        ['viewType', 'valid', 'bad-type', 'Tool'],
        ['toolName', 'valid', 'View', 'bad-tool'],
    ] as const)('identifies the invalid %s field and recommends underscores', (field, appName, viewType, toolName) => {
        expect(() => buildPublicToolName(appName, viewType, toolName))
            .toThrow(new RegExp(`AOTUI_TOOL_NAME_INVALID: ${field}.*Replace hyphens.*underscores`));
    });

    it.each(['has space', '名字', 'has/slash', ''])('rejects unsupported component %j without sanitizing it', value => {
        expect(() => buildPublicToolName(value, 'View', 'tool'))
            .toThrow(/AOTUI_TOOL_NAME_INVALID: appName/);
    });

    it.each([63, 64])('accepts a complete native name of %i characters', length => {
        const name = buildPublicToolName('a', 'b', 'x'.repeat(length - 4));
        expect(name).toHaveLength(length);
    });

    it('rejects a complete native name over 64 characters', () => {
        expect(() => buildPublicToolName('a', 'b', 'x'.repeat(61)))
            .toThrow('AOTUI_TOOL_NAME_INVALID: the combined native Tool name has 65 characters');
    });

    it('measures a short name using its two emitted parts', () => {
        expect(buildPublicToolName('a', 'x'.repeat(62))).toHaveLength(64);
        expect(() => buildPublicToolName('a', 'x'.repeat(63)))
            .toThrow('AOTUI_TOOL_NAME_INVALID: the combined native Tool name has 65 characters');
    });

    it('qualifies repeated and reserved names without changing the source tool IDs', () => {
        const source = observation('system', ['Archive', 'read'], ['Inbox', 'read'], ['Inbox', 'open_app'], ['Inbox', 'search']);
        const [names] = projectNativeToolNames([source]);
        if (names?.status !== 'ready') throw Error('Expected named tools');
        expect([...names.tools.keys()]).toEqual(['system-Archive-read', 'system-Inbox-read', 'system-Inbox-open_app', 'system-search']);
        expect([...names.tools.values()]).toEqual(source.tools);
    });

    it('reports invalid aliases and collisions per observation while retaining its valid peers', () => {
        const healthy = observation('notes', ['Inbox', 'read']);
        const tooLong = observation('archive', ['List', 'x'.repeat(65)]);
        const conflict = observation('notes', ['Archive', 'read']);
        const duplicate = observation('duplicates', ['Inbox', 'read'], ['Inbox', 'read']);
        expect(projectNativeToolNames([healthy, tooLong, conflict, duplicate])).toMatchObject([
            { status: 'ready', tools: new Map([['notes-read', healthy.tools[0]]]) },
            { status: 'rejected', issue: { code: 'AOTUI_TOOL_NAME_INVALID', path: 'publicToolName' } },
            { status: 'rejected', issue: { code: 'AOTUI_TOOL_NAME_COLLISION', message: expect.stringContaining('another App') } },
            { status: 'rejected', issue: { code: 'AOTUI_TOOL_NAME_COLLISION', message: expect.stringContaining('this App') } },
        ]);
    });
});
