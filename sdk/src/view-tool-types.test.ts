import { describe, expect, it } from 'vitest';
import Type from 'typebox';
import { defineViewTypeTool, defineToolSet, refParam, type ToolBindings, type ToolSetMap } from './tools/view-type-tool.js';
import { AppTools } from './components/AppTools.js';

function typeContract() {
    const inspect = defineViewTypeTool({ viewType: 'FileDetail', name: 'inspect', description: 'Inspect.',
        inputSchema: Type.Object({ file: refParam('File', Type.Object({ path: Type.String() })), query: Type.String() }),
    });
    const tools = defineToolSet({ inspect });
    const bindings: ToolBindings<ToolSetMap<typeof tools>> = { inspect: { execute(args) {
        const path: string = args.file.path;
        // @ts-expect-error Resolved Ref fields are recursively read-only.
        args.file.path = path;
        // @ts-expect-error Ordinary arguments are recursively read-only.
        args.query = 'changed';
        return { success: true };
    } } };
    void bindings;
    // @ts-expect-error A plain JSON Schema type is not a TypeBox author Schema.
    defineViewTypeTool({ viewType: 'FileDetail', name: 'bad', description: 'Bad', inputSchema: { type: 'object' } });
}
void typeContract;
describe('one ViewType Tool contract for ordinary and Ref parameters', () => {
    it('exports App registration and the Ref parameter declaration', () => {
        expect(typeof AppTools).toBe('function');
        expect(typeof refParam).toBe('function');
        expect(typeof defineViewTypeTool).toBe('function');
    });
});
