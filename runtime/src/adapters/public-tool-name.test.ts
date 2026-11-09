import { describe, expect, it } from 'vitest';
import { buildPublicToolName } from './public-tool-name.js';

describe('native public Tool names', () => {
    it('joins valid component names with an unambiguous separator', () => {
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
});
