import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileToolParameters } from '@aotui/core';
import { createRuntime } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

describe('Batch 1 refParam business contract and adapter projections', () => {
    it('delivers declared Ref values and arbitrary bounded JSON through Native and run_code in a Worker', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'aotui-ref-param-adapters-'));
        const appName = 'work_board';
        const workItem = { id: 'WI-42', title: 'Ship Batch 1', priority: 1 };
        const values = ['$balance', 3.25, false, null, [1, 'mixed', false, null, { leaf: '$raw' }],
            { 'arbitrary-key': { another: [true, null] }, price: '$same' }];
        const originals = ['$ref.x', '$$ref.x', '$$$ref.x', '正文 $ref.x'];
        const spellings = ['$$ref.x', '$$$ref.x', '$$$$ref.x', '正文 $ref.x'];
        const runtime = createRuntime({});
        let source: SemanticAOTUIDrivenSource | undefined;
        let current: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>> | undefined;

        try {
            const root = process.cwd();
            await mkdir(join(folder, 'node_modules', '@aotui'), { recursive: true });
            await symlink(resolve(root, 'node_modules/@aotui/core'), join(folder, 'node_modules/@aotui/core'));
            await symlink(resolve(root, 'node_modules/@aotui/sdk'), join(folder, 'node_modules/@aotui/sdk'));
            await symlink(realpathSync(resolve(root, 'sdk/node_modules/typebox')), join(folder, 'node_modules/typebox'));

            await writeFile(join(folder, 'package.json'), JSON.stringify({
                name: 'work-board-fixture',
                version: '1.0.0',
                aotui: { app_name: appName },
                private: true,
                type: 'module',
                main: './entry.mjs',
            }));
            const entryPath = join(folder, 'entry.mjs');
            await writeFile(entryPath, `
import Type from 'typebox';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, createView, defineViewType, ref, refParam } from '@aotui/sdk';

export const WorkItemSchema = Type.Object({
    id: Type.String(),
    title: Type.String(),
    priority: Type.Integer(),
}, { additionalProperties: false });
let arbitraryCalls = 0;
let refCalls = 0;
let writes = 0;

export const BoardType = defineViewType()({
    name: 'Board',
    multiplicity: 'multiple',
    tools: {
        assign: {
            description: 'Assign the selected WorkItem.',
            inputSchema: Type.Object({
                item: refParam('WorkItem', WorkItemSchema),
                note: Type.Optional(Type.String()),
            }, { additionalProperties: false }),
            execute({ input }) {
                return {
                    success: true,
                    data: {
                        received: input.item,
                        frozen: Object.isFrozen(input.item),
                        note: input.note ?? null,
                        calls: ++refCalls,
                    },
                };
            },
        },
        round_trip: {
            description: 'Report the actual JSON values received by this handler.',
            inputSchema: Type.Object({
                body: Type.Unknown(),
                values: Type.Array(Type.Unknown()),
                nested: Type.Object({ payload: Type.Unknown() }, { additionalProperties: false }),
            }),
            execute({ input }) {
                return { success: true, data: { received: input,
                    type: input.body === null ? 'null' : Array.isArray(input.body) ? 'array' : typeof input.body,
                    calls: ++arbitraryCalls } };
            },
        },
        write_text: {
            description: 'Write exact text.',
            inputSchema: {
                type: 'object', properties: { value: { type: 'string', enum: ${JSON.stringify(originals)} } },
                required: ['value'],
            },
            async execute({ input, context }) {
                await writeFile(join(context.path, 'text-' + ++writes), input.value, 'utf8');
                return { success: true };
            },
        },
    },
});

export default createApp({
    app_name: 'work_board',
    viewTypes: [BoardType],
    initialize({ prepareProjection, readViewId }) {
        const board = createView(BoardType, {
            idPrefix: 'board',
            region: 'dynamic',
            name: 'Work board',
            render: () => ({
                body: 'Work item ready for selection.',
                refs: [
                    ref('work_item', ${JSON.stringify(workItem)}, {
                        scope: 'public',
                        refType: 'WorkItem',
                        schema: WorkItemSchema,
                    }),
                    ref('wrong_value', 'text', { scope: 'protected', refType: 'WorkItem', schema: Type.String() }),
                ],
                context: { path: ${JSON.stringify(folder)} },
            }),
        });
        prepareProjection({ views: [board] });
        if (readViewId(board) !== 'board_1') throw new Error('Plain author did not receive the committed View ID');
    },
});
`);

            const { BoardType } = await import(pathToFileURL(entryPath).href);
            const exported = BoardType.tools.assign.inputSchema;
            const itemSchema = exported.properties.item;
            expect(itemSchema).toEqual({
                'x-aotui-ref-kind': 'WorkItem',
                'x-aotui-ref-value': {
                    type: 'object',
                    required: ['id', 'priority', 'title'],
                    properties: {
                        id: { type: 'string' },
                        title: { type: 'string' },
                        priority: { type: 'integer' },
                    },
                    additionalProperties: false,
                },
            });
            expect(itemSchema).not.toHaveProperty('type');
            expect(itemSchema).not.toHaveProperty('minLength');

            const compiled = compileToolParameters(exported);
            expect(compiled.ok).toBe(true);
            if (!compiled.ok) throw new Error('Expected WorkItem refParam schema to compile');

            const { buildAoappManifest, writeAoappManifest } = await import(
                pathToFileURL(resolve(root, 'sdk/bin/generate-aoapp.mjs')).href
            );
            await writeAoappManifest(folder, await buildAoappManifest(folder));

            const desktopId = (await runtime.createDesktop('desktop_ref_param')).id;
            const desktop = runtime.getDesktop(desktopId);
            const installationId = await desktop.registerPendingApp({ installationId: appName, localPath: folder });
            const appId = (await desktop.openApp(installationId)).appId;

            source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
            current = await source.getContext();
            await current.adopt!();

            const nativeTool = current.tools[appId + '-assign'];
            expect(nativeTool).toBeDefined();
            const nativeSchema = nativeTool!.inputSchema as { jsonSchema: Record<string, any> };
            expect(nativeSchema.jsonSchema.properties.item).toEqual({
                type: 'string',
                description: expect.stringMatching(/WorkItem.*\$ref\.app_id\.view_id\.ref_id/),
            });

            expect(current.tools.run_code).toBeDefined();
            const bindings = current.messages.filter(message => message.role === 'user' && message.region === 'dynamic' &&
                typeof message.content === 'string' && message.content.startsWith('## Console bindings for this request'));
            expect(bindings).toHaveLength(1);
            const declaration = bindings[0]!.content;
            expect(declaration).toContain('readonly item: AppRefAddress');
            expect(declaration).toContain('readonly body: JsonValue');
            expect(declaration).toContain('work_item');

            const rejectedNative = await current.executeTool!(appId + '-assign', {
                view_id: 'board_1',
                item: 'literal-string-not-a-ref',
                note: 'bad-native',
            }, 'native-bad');
            expect(rejectedNative).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_TYPE_MISMATCH', message: expect.stringContaining('$.item') } });
            const wrongRef = await current.executeTool!(appId + '-assign', {
                view_id: 'board_1', item: '$ref.' + appId + '.board_1.wrong_value',
            }, 'native-wrong-shape');
            expect(wrongRef).toMatchObject({ outcomeStatus: 'rejected',
                error: { code: 'REF_VALUE_UNSUPPORTED', message: expect.stringContaining('$.item') } });

            const nativeResult = await current.executeTool!(appId + '-assign', {
                view_id: 'board_1',
                item: '$ref.' + appId + '.board_1.work_item',
                note: 'via-native',
            }, 'native-ok');
            expect(nativeResult).toMatchObject({
                outcomeStatus: 'succeeded',
                result: { received: workItem, frozen: true, note: 'via-native', calls: 1 },
            });

            const toolName = appId + '-round_trip';
            const routed = current.tools[toolName]!.inputSchema as { jsonSchema: Record<string, any> };
            expect(routed.jsonSchema.properties.body).toEqual({});
            const parameters = (value: unknown) => ({ body: value, values: [value, null], nested: { payload: value } });
            const oversized = await current.executeTool!(toolName, { view_id: 'board_1', ...parameters(null), body: 'x'.repeat(130 * 1024) }, 'native-too-large');
            expect(oversized).toMatchObject({ outcomeStatus: 'rejected',
                error: { code: 'ACTION_INPUT_INVALID', message: expect.stringContaining('$["body"]') } });
            const expected = values.map((value, index) => ({ received: parameters(value), calls: index + 1,
                type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value }));
            for (const [index, value] of values.entries()) {
                const result = await current.executeTool!(toolName, { view_id: 'board_1', ...parameters(value) }, 'native-json-' + index);
                expect(result).toMatchObject({ outcomeStatus: 'succeeded', result: expected[index] });
            }

            const consoleResult = await current.executeTool!('run_code', {
                code: `
let literalError, inlineError;
try {
    await tools[${JSON.stringify(appId + '-assign')}]({ view_id: 'board_1', item: 'literal-string-not-a-ref', note: 'bad-console' });
} catch (error) {
    literalError = error?.code ?? String(error);
}
try {
    await tools[${JSON.stringify(appId + '-assign')}]({ view_id: 'board_1', item: refs.${appId}.board_1.work_item, note: 'inline-console' });
} catch (error) {
    inlineError = error?.code ?? String(error);
}
const ok = await tools[${JSON.stringify(appId + '-assign')}]({ view_id: 'board_1', item: ${JSON.stringify('$ref.' + appId + '.board_1.work_item')}, note: 'via-console' });
const roundTrips = [];
for (const body of ${JSON.stringify(values)}) {
    roundTrips.push(await tools[${JSON.stringify(toolName)}]({ view_id: 'board_1', body, values: [body, null], nested: { payload: body } }));
}
console.log(JSON.stringify({ literalError, inlineError, ok, roundTrips }));
`,
            }, 'console-ok');
            expect(consoleResult).toMatchObject({ outcomeStatus: 'succeeded' });
            const parsedOutput = JSON.parse(String((consoleResult!.result as { output: string[] }).output[0]));
            expect(parsedOutput.literalError).toBe('REF_TYPE_MISMATCH');
            expect(parsedOutput.inlineError).toBe('REF_TYPE_MISMATCH');
            expect(parsedOutput.ok).toEqual({
                received: workItem,
                frozen: true,
                note: 'via-console',
                calls: 2,
            });
            expect(parsedOutput.roundTrips).toEqual(expected.map(result => ({ ...result, calls: result.calls + values.length })));

            const writeTool = appId + '-write_text';
            const writeSchema = current.tools[writeTool]!.inputSchema as { jsonSchema: Record<string, any> };
            expect(writeSchema.jsonSchema.properties.value).toMatchObject({ anyOf: [
                { enum: spellings }, { type: 'string', pattern: expect.any(String) },
            ] });
            expect(declaration).toContain(JSON.stringify(spellings[1]));
            const rejectedText = await current.executeTool!(writeTool, { view_id: 'board_1', value: 'turbo' }, 'native-bad-text');
            expect(rejectedText).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_INVALID_ARGS' } });
            for (const [index, value] of spellings.entries()) {
                expect(await current.executeTool!(writeTool, { view_id: 'board_1', value }, 'text-' + index))
                    .toMatchObject({ outcomeStatus: 'succeeded' });
            }
            const writeFromConsole = await current.executeTool!('run_code', { code: `
for (const value of ${JSON.stringify(spellings)}) {
    await tools[${JSON.stringify(writeTool)}]({ view_id: 'board_1', value });
}
` }, 'console-edit');
            expect(writeFromConsole).toMatchObject({ outcomeStatus: 'succeeded' });
            for (const [index, expected] of [...originals, ...originals].entries())
                expect(await readFile(join(folder, 'text-' + (index + 1)))).toEqual(Buffer.from(expected));
            await expect(readFile(join(folder, 'text-9'))).rejects.toHaveProperty('code', 'ENOENT');
        } finally {
            await current?.release?.();
            source?.dispose();
            await runtime.beginClose().completion;
            await rm(folder, { recursive: true, force: true });
        }
    }, 15_000);
});
