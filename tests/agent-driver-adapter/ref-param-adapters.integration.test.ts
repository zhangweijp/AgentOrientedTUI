import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { fixtureProvider } from '../fixtures/batch-two-support.mjs';
import type { ActiveTurn, ObservationCandidate, ObservationOptions } from '@aotui/runtime';
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
            await writeFile(entryPath, `import Type from 'typebox';
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
let choiceCalls = 0;

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
        choices: {
            description: 'Accept exactly the resolved array [fast].',
            inputSchema: {
                type: 'object', properties: {
                    choices: { type: 'array', items: { type: 'string' }, enum: [['fast']] },
                    literal: { type: 'string', default: '$ref.x' },
                    literal_const: { type: 'string', const: '$ref.x', default: '$ref.x' },
                    tuple: { type: 'array', items: false, minItems: 3, prefixItems: [
                        { type: 'string', const: '$ref.x' },
                        { type: 'string', enum: ['$$ref.x'] },
                        { type: 'string', const: '$$$ref.x' },
                    ] },
                    escaped: { type: 'array', items: { type: 'string' } },
                    nested: { type: 'object', properties: { literal: { type: 'string' } }, required: ['literal'], additionalProperties: false },
                }, required: ['choices'], additionalProperties: false,
            },
            execute({ input }) {
                return { success: true, data: { calls: ++choiceCalls, input, hasDefault: Object.hasOwn(input, 'literal') } };
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
    initialize({ publish: publishAuthorFrame, readViewId }) {
        const board = (() => { const handle = createView(BoardType, { idPrefix: 'board', region: 'dynamic' }); const displayName = 'Work board'; return { handle, frame: () => handle.frame({ name: displayName, body: 'Work item ready for selection.', refs: [
                    ref('work_item', ${JSON.stringify(workItem)}, {
                        scope: 'public',
                        refType: 'WorkItem',
                        schema: WorkItemSchema,
                    }),
                    ref('fast', 'fast', { scope: 'public', schema: Type.String() }),
                    ref('turbo', 'turbo', { scope: 'public', schema: Type.String() }),
                    ref('wrong_value', 'text', { scope: 'protected', refType: 'WorkItem', schema: Type.String() }),
                ], context: { path: ${JSON.stringify(folder)} } }) }; })();
        publishAuthorFrame(() => ([board]).map(page => page.frame()));
        if (readViewId(board.handle) !== 'board_1') throw new Error('Plain author did not receive the committed View ID');
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

            const nativeTool = current.tools[appId + '-Board-assign'];
            expect(nativeTool).toBeDefined();
            const nativeSchema = nativeTool!.inputSchema as { jsonSchema: Record<string, any> };
            expect(nativeSchema.jsonSchema.properties.item).toEqual({
                type: 'string', pattern: expect.any(String),
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

            const rejectedNative = await current.executeTool!(appId + '-Board-assign', {
                view_id: 'board_1',
                item: 'literal-string-not-a-ref',
                note: 'bad-native',
            }, 'native-bad');
            expect(rejectedNative).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_TYPE_MISMATCH', message: expect.stringContaining('$.item') } });
            const wrongRef = await current.executeTool!(appId + '-Board-assign', {
                view_id: 'board_1', item: '$ref.' + appId + '.board_1.wrong_value',
            }, 'native-wrong-shape');
            expect(wrongRef).toMatchObject({ outcomeStatus: 'rejected',
                error: { code: 'REF_VALUE_UNSUPPORTED', message: expect.stringContaining('$.item') } });

            const nativeResult = await current.executeTool!(appId + '-Board-assign', {
                view_id: 'board_1',
                item: '$ref.' + appId + '.board_1.work_item',
                note: 'via-native',
            }, 'native-ok');
            expect(nativeResult).toMatchObject({
                outcomeStatus: 'succeeded',
                result: { received: workItem, frozen: true, note: 'via-native', calls: 1 },
            });

            const toolName = appId + '-Board-round_trip';
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
    await tools[${JSON.stringify(appId + '-Board-assign')}]({ view_id: 'board_1', item: 'literal-string-not-a-ref', note: 'bad-console' });
} catch (error) {
    literalError = error?.code ?? String(error);
}
try {
    await tools[${JSON.stringify(appId + '-Board-assign')}]({ view_id: 'board_1', item: refs.${appId}.board_1.work_item, note: 'inline-console' });
} catch (error) {
    inlineError = error?.code ?? String(error);
}
const ok = await tools[${JSON.stringify(appId + '-Board-assign')}]({ view_id: 'board_1', item: ${JSON.stringify('$ref.' + appId + '.board_1.work_item')}, note: 'via-console' });
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

            // D5-A: generation accepts both addresses; only the original business enum authorizes the resolved array.
            const choiceName = appId + '-Board-choices';
            const fast = '$ref.' + appId + '.board_1.fast';
            const turbo = '$ref.' + appId + '.board_1.turbo';
            const choiceInput = (address: string) => ({ view_id: 'board_1', choices: [address] });
            const projected = (current.tools[choiceName]!.inputSchema as { jsonSchema: Record<string, unknown> }).jsonSchema;
            expect(projected).toMatchObject({ properties: { choices: { anyOf: [
                { type: 'array', items: { type: 'string' } }, { type: 'string', pattern: expect.any(String) },
            ] } } });
            expect(BoardType.tools.choices.inputSchema.properties.choices.enum).toEqual([['fast']]);
            const rejectedChoice = await current.executeTool!(choiceName, choiceInput(turbo), 'choice-turbo');
            expect(rejectedChoice).toMatchObject({ outcomeStatus: 'rejected', error: {
                code: 'TOOL_INVALID_ARGS', message: expect.stringContaining('$.choices'),
            } });
            const validChoice = await current.executeTool!(choiceName, {
                ...choiceInput(fast), literal_const: spellings[0], tuple: spellings.slice(0, 3), escaped: spellings, nested: { literal: '$ref.x' },
            }, 'choice-fast');
            expect(validChoice).toMatchObject({ outcomeStatus: 'succeeded', result: {
                calls: 1, hasDefault: false, input: { choices: ['fast'], literal_const: originals[0], tuple: originals.slice(0, 3), escaped: originals, nested: { literal: '$ref.x' } },
            } });
            const consoleChoice = await current.executeTool!('run_code', { code: `
let rejected;
try { await tools[${JSON.stringify(choiceName)}](${JSON.stringify(choiceInput(turbo))}); }
catch (error) { rejected = { code: error.code, message: error.message }; }
const ok = await tools[${JSON.stringify(choiceName)}](${JSON.stringify({ ...choiceInput(fast), literal_const: spellings[0], tuple: spellings.slice(0, 3), escaped: spellings, nested: { literal: '$ref.x' } })});
console.log(JSON.stringify({ rejected, ok }));
` }, 'choice-console');
            expect(consoleChoice).toMatchObject({ outcomeStatus: 'succeeded' });
            expect(JSON.parse(String((consoleChoice!.result as { output: string[] }).output[0]))).toMatchObject({
                rejected: { code: 'TOOL_INVALID_ARGS', message: expect.stringContaining('$.choices') },
                ok: { calls: 2, input: { choices: ['fast'], literal_const: originals[0], tuple: originals.slice(0, 3), escaped: originals, nested: { literal: '$ref.x' } }, hasDefault: false },
            });

            const writeTool = appId + '-Board-write_text';
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

it('keeps Editor.save declaration stable through real mounts and Ref changes and isolates a compiler-only failure', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'aotui-stable-declaration-'));
    const runtime = createRuntime({});
    let source: SemanticAOTUIDrivenSource | undefined;
    let current: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>> | undefined;
    try {
        const root = process.cwd();
        await mkdir(join(folder, 'node_modules', '@aotui'), { recursive: true });
        for (const name of ['core', 'sdk']) await symlink(resolve(root, 'node_modules/@aotui', name), join(folder, 'node_modules/@aotui', name));
        const modulePath = join(folder, 'app.mjs');
        await writeFile(modulePath, `
import { createApp, createView, defineViewType, ref } from '@aotui/sdk';
const inputSchema = { type: 'object', properties: { choice: { type: 'string', enum: ['fast', 'accurate'] } }, required: ['choice'], additionalProperties: false };
const Editor = defineViewType()({ name: 'Editor', multiplicity: 'multiple', tools: {
    save: { description: 'Save the selected Editor.', inputSchema, execute({ context }) { return context.advance(); } },
} });
const Search = defineViewType()({ name: 'Search', multiplicity: 'single', tools: {
    save: { description: 'Save the Search.', inputSchema, execute() { return { success: true }; } },
} });
export default createApp({ app_name: 'workspace', viewTypes: [Editor, Search], initialize({ publish: commit }) {
    const first = createView(Editor, { idPrefix: 'editor', region: 'dynamic' });
    const second = createView(Editor, { idPrefix: 'editor', region: 'dynamic' });
    const search = createView(Search, { id: 'search', region: 'dynamic' });
    let step = 0;
    const context = { advance() { step++; publish(); return { success: true, data: { step } }; } };
    function publish() {
        const refs = step === 0 ? [] : [ref('choice', step < 4 ? (step === 1 ? 'fast' : 'accurate') : 7,
            { scope: step < 4 ? 'public' : step === 4 ? 'protected' : 'private', schema: { type: step < 4 ? 'string' : 'integer' } })];
        const views = [first.frame({ body: 'Editor step ' + step, refs, context })];
        if (step >= 2 && step < 5) views.push(second.frame({ body: 'Second Editor', context }));
        if (step >= 3 && step < 5) views.push(search.frame({ body: 'Search', context: {} }));
        commit(() => views);
    }
    publish();
} });
`);
        const badPath = join(folder, 'compiler-fault.mjs');
        await writeFile(badPath, `
import { createApp, createView, defineViewType } from '@aotui/sdk';
const Invalid = defineViewType()({ name: 'Draft', multiplicity: 'single', tools: {
    revise: { description: 'A Core-valid declaration outside the model profile.', inputSchema: {
        type: 'object', properties: { choice: { type: 'array', items: { type: 'string' }, anyOf: [{ const: ['fast'] }] } }, required: ['choice'],
    }, execute() { throw Error('A compiler-excluded tool must not enter the handler'); } },
} });
export default createApp({ app_name: 'compiler_fault', viewTypes: [Invalid], initialize({ publish }) {
    const draft = createView(Invalid, { id: 'draft', region: 'dynamic' });
    publish(() => [draft.frame({ body: 'Healthy business data', context: {} })]);
} });
`);
        const desktop = await runtime.createDesktop('stable-declaration');
        const running = await desktop.installDynamicWorkerApp(modulePath, { name: 'workspace', installationId: 'first' });
        source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
        const name = running.appId + '-Editor-save';
        const schemas: unknown[] = [];
        const observe = async () => {
            await current?.release?.();
            current = await source!.getContext();
            return current;
        };
        for (let step = 0; step <= 5; step++) {
            const context = await observe();
            const tools = Object.keys(context.tools);
            expect(tools.filter(tool => tool === name)).toHaveLength(1);
            expect(tools.includes(running.appId + '-Search-save')).toBe(step >= 3 && step < 5);
            const schema = (context.tools[name]!.inputSchema as { jsonSchema: unknown }).jsonSchema;
            schemas.push(schema);
            expect(schema).toEqual(schemas[0]);
            expect(schema).toMatchObject({ required: ['view_id', 'choice'], properties: { view_id: { type: 'string' } } });
            const preview = await running.preview();
            if (preview.status !== 'previewed') throw Error(preview.issue.code);
            expect(preview.views.filter(view => view.type === 'Editor')).toHaveLength(step >= 2 && step < 5 ? 2 : 1);
            expect(preview.views.find(view => view.type === 'Editor')?.content.value).toContain('step ' + step);
            if (step < 5) {
                await context.adopt!();
                expect(await context.executeTool!(name, { view_id: 'editor_1', choice: 'fast' }, 'step-' + step))
                    .toMatchObject({ outcomeStatus: 'succeeded', result: { step: step + 1 } });
            }
        }
        const other = await desktop.installDynamicWorkerApp(modulePath, { name: 'workspace', installationId: 'second' });
        expect(other.appId).not.toBe(running.appId);
        const bad = await desktop.installDynamicWorkerApp(badPath, { name: 'compiler_fault', installationId: 'bad' });
        const before = await bad.preview();
        expect(before).toMatchObject({ status: 'previewed', views: [{ content: { value: 'Healthy business data' } }] });
        const context = await observe();
        expect(context.tools[name]).toBeDefined();
        expect(context.tools[other.appId + '-Editor-save']).toBeDefined();
        expect(Object.keys(context.tools).filter(name => name.startsWith(bad.appId + '-'))).toEqual([]);
        expect(JSON.stringify(context.messages)).toContain('MODEL_TOOL_SCHEMA_UNSUPPORTED');
        expect(JSON.stringify(context.messages)).toContain('$.properties.choice.anyOf');
        expect(JSON.stringify(context.messages)).toContain('Healthy business data');
        await context.adopt!();
        expect(await bad.preview()).toEqual(before);
        const direct = await bad.observe();
        expect(direct).toMatchObject({ status: 'prepared' });
        if (direct.status === 'prepared') direct.candidate.discard();
    } finally {
        await current?.release?.();
        source?.dispose();
        await runtime.beginClose().completion;
        await rm(folder, { recursive: true, force: true });
    }
}, 15_000);

it.each([{budget:false,mode:'ok'},{budget:true,mode:'ok'},{budget:true,mode:'second'},{budget:false,mode:'xml'},{budget:false,mode:'occupied'},{budget:false,mode:'after'}])('B4-T02/03/05/06 actual final request and narrow adopted grant ($budget / $mode)', async ({budget,mode}) => {
    const folder=await mkdtemp(join(tmpdir(),'b4-narrow-'));
    const runtime=createRuntime({worker:{timeoutMs:5000}});
    const provider=await fixtureProvider({captureRaw:true});
    let source:SemanticAOTUIDrivenSource|undefined, driver:AgentDriverV2|undefined;
    const sdk=pathToFileURL(resolve('sdk/dist/index.js')).href;
    try{
        const entry=join(folder,'app.mjs');
        await writeFile(entry,`
import {createApp,createView,defineViewType,ref} from ${JSON.stringify(sdk)};
const empty={type:'object',properties:{}};
const D=defineViewType()({name:'Detail',multiplicity:'single',region:'dynamic',tools:{
 advance:{description:'Advance original data',inputSchema:empty,execute:({context})=>context.advance()},
 read:{description:'Read a number',inputSchema:{type:'object',properties:{number:{type:'integer'}},required:['number']},execute:({input})=>({success:true,data:input})},
 revise:{description:'Unsupported model compiler',inputSchema:{type:'object',properties:{choice:{type:'array',items:{type:'string'},anyOf:[{const:['fast']}]}},required:['choice']},execute:()=>{throw Error('must not dispatch revise')}},
 late:{description:'New unsupported declaration after narrow',enabled:({isLate})=>isLate(),inputSchema:{type:'object',properties:{choice:{type:'array',items:{type:'string'},anyOf:[{const:['late']}]}},required:['choice']},execute:()=>{throw Error('must not dispatch late')}},
 echo:{description:'Echo JSON data',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},execute:({input})=>({success:true,data:input})},
 another:{description:'Second unsupported declaration',inputSchema:{type:'object',properties:{choice:{type:'array',items:{type:'string'},anyOf:[{const:['slow']}]}},required:['choice']},execute:()=>{throw Error('must not dispatch another')}}
},onClose:{execute:()=>({success:true,data:{removed:false}})}});
const page=createView(D,{id:'detail',region:'dynamic'});
export default createApp({app_name:'narrow',viewTypes:[D],initialize({publish}){
 let version=1;const context={isLate(){return ${JSON.stringify(mode==='second')}&&version===2;},advance(){version++;show();return {success:true,data:{version}};}};
 function show(){publish(()=>[page.frame({body:'version-'+version+(${JSON.stringify(mode==='xml')}&&version===2?'\\0':''),context,refs:[ref('value',version,{scope:'public',refType:'Number',schema:{type:'integer'}})]})]);}show();
}});
`);
        const desktop=await runtime.createDesktop('narrow');
        const app=await desktop.installDynamicWorkerApp(entry,{name:'narrow'});
        const original=await app.observe(); if(original.status!=='prepared')throw Error(original.issue.code);
        const old=desktop.adoptTurn({apps:[{candidate:original.candidate}]});if(old.status!=='adopted')throw Error(old.issue.code);
        const prior=original.candidate.observation;
        const advance=prior.tools.find(t=>t.name==='advance')!;
        const excluded=prior.tools.filter(t=>['revise','another'].includes(t.name)).map(t=>t.id);
        const echo=prior.tools.find(t=>t.name==='echo')!;
        expect(await old.turn.invoke(app.appId,{observationId:prior.observationId,toolId:echo.id,invocationId:'non-xml-json',input:{value:'A\0B'}}))
            .toMatchObject({kind:'receipt',receipt:{outcome:{status:'succeeded',value:{success:true,data:{value:'A\0B'}}}}});

        const preparations:{options:ObservationOptions|undefined;candidate:ObservationCandidate}[]=[];
        let competing:ObservationCandidate|undefined;
        const lookup=desktop.getRunningApp.bind(desktop);
        vi.spyOn(desktop,'getRunningApp').mockImplementation((id,instance)=>{
            const access=lookup(id,instance);
            if(access.status!=='ready')return access;
            return {...access,app:{...access.app,observe:async options=>{
                if(options?.excludeToolIds?.length) {
                    expect([...options.excludeToolIds].sort()).toEqual([...excluded].sort());
                    expect(preparations).toHaveLength(1);
                    expect(old.turn.isCurrent).toBe(true);
                    expect(await old.turn.invoke(app.appId,{observationId:prior.observationId,toolId:advance.id,invocationId:'old-advance',input:{}}))
                        .toMatchObject({kind:'receipt',receipt:{outcome:{status:'succeeded'}}});
                    if(mode==='occupied'){
                        const other=await app.observe();
                        expect(other.status).toBe('prepared');
                        if(other.status==='prepared')competing=other.candidate;
                    }
                }
                const result=await access.app.observe(options);
                if(result.status==='prepared')preparations.push({options,candidate:result.candidate});
                return result;
            }}};
        });
        let adopted:ActiveTurn|undefined;
        const actualAdopt=desktop.adoptTurn.bind(desktop);
        const adoptedSelections:ObservationCandidate[]=[];
        vi.spyOn(desktop,'adoptTurn').mockImplementation(input=>{
            adoptedSelections.push(...input.apps.map(app=>app.candidate));
            const result=actualAdopt(input);
            if(result.status==='adopted')adopted=result.turn;
            return result;
        });
        source=new SemanticAOTUIDrivenSource(desktop);
        const errors:unknown[]=[];
        const originalContext=source.getContext.bind(source);
        let capturedContext:Awaited<ReturnType<typeof originalContext>>|undefined;
        vi.spyOn(source,'getContext').mockImplementation(async policy=>capturedContext=await originalContext(policy));
        let budgetReads=0;
        driver=new AgentDriverV2({sources:[source],llm:{model:'b4-local',provider:{id:'b4-fixture',baseURL:provider.url},apiKey:'test-only',
            ...(budget?{inputBudget:()=>{budgetReads++;return {contextWindow:100000,maxOutputTokens:2048}}}:{})},
            onRunError:error=>errors.push(error)});
        if(mode==='ok'||mode==='after')provider.replyNext({label:'narrow-final',...(mode==='after'?{errorStatus:400}:{}),beforeReply:async body=>{
            expect(preparations).toHaveLength(2);
            const [c,narrow]=preparations;
            expect(narrow!.candidate.observation.source.revision).toBeGreaterThan(c!.candidate.observation.source.revision);
            expect(adoptedSelections).toEqual([narrow!.candidate]);
            expect(old.turn.isCurrent).toBe(false);
            expect(JSON.stringify(body.messages)).toContain('version-2');
            expect(JSON.stringify(body.messages)).not.toContain('version-1');
            expect(JSON.stringify(body.messages)).toContain('$ref.narrow.detail.value');
            const names=body.tools.map(t=>t.function.name);
            expect(names).toContain('narrow-Detail-read');
            expect(names).toContain('system-close_view');
            expect(names).toContain('run_code');
            expect(names).not.toContain('narrow-Detail-revise');
            expect(names).not.toContain('narrow-Detail-another');
            const selected=narrow!.candidate.observation;
            const values=await adopted!.readPublicRefs(['$ref.narrow.detail.value']);
            expect(values).toMatchObject({status:'ready',refs:[{value:2}]});
            for(const toolId of excluded) {
                const rejected=await adopted!.invoke(app.appId,{observationId:selected.observationId,toolId,invocationId:'excluded-'+toolId,input:{choice:['fast']}});
                expect(rejected).toMatchObject({kind:'refused'});
            }
            expect(selected.views[0]?.canClose).toBe(true);
            const declaration=body.messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.map(p=>p.text??'')).find(t=>t.startsWith('## Console bindings'));
            expect(declaration).toBeDefined();
            expect(declaration).not.toContain('narrow-Detail-revise');expect(declaration).not.toContain('narrow-Detail-another');
            expect(await capturedContext!.executeTool!('narrow-Detail-revise',{},'excluded-native')).toBeUndefined();
            const code=await capturedContext!.executeTool!('run_code',{code:
                'console.log(typeof tools["narrow-Detail-revise"]);console.log(await tools["narrow-Detail-read"]({number:"$ref.narrow.detail.value"}));'},'narrow-console');
            expect(code).toMatchObject({outcomeStatus:'succeeded'});
            expect(JSON.stringify(code?.result)).toContain('undefined');expect(JSON.stringify(code?.result)).toContain('2');
        }});
        await driver.trigger(); await (driver as unknown as {runInFlight?:Promise<void>}).runInFlight;
        expect(provider.failures).toEqual([]);
        expect(preparations).toHaveLength(mode==='occupied'?1:2);
        if(mode==='ok') {
            expect(errors).toEqual([]);expect(provider.requests).toHaveLength(1);
            expect(budgetReads>0).toBe(budget);
        }else if(mode==='after'){
            expect(errors).toHaveLength(1);expect(provider.requests).toHaveLength(1);
            expect(adoptedSelections).toHaveLength(1);expect(old.turn.isCurrent).toBe(false);
        }else{
            expect(errors).toHaveLength(1);expect(provider.requests).toHaveLength(0);expect(adoptedSelections).toEqual([]);
            expect(old.turn.isCurrent).toBe(true);
            expect(errors[0]).toMatchObject({code:mode==='xml'?'AOTUI_XML_UNSUPPORTED':mode==='occupied'?'OBSERVATION_CAPACITY':'MODEL_TOOL_SCHEMA_UNSUPPORTED'});
            expect(await old.turn.readPublicRefs(['$ref.narrow.detail.value'])).toMatchObject({status:'ready',refs:[{value:1}]});
            if(mode==='occupied'){
                expect(competing).toBeDefined();
                expect(await app.observe()).toMatchObject({status:'rejected',issue:{code:'OBSERVATION_CAPACITY'}});
                expect(competing!.discard()).toEqual([]);
            }
            const verifySlot=await app.observe();expect(verifySlot.status).toBe('prepared');
            if(verifySlot.status==='prepared')expect(verifySlot.candidate.discard()).toEqual([]);
        }
    }finally{driver?.dispose();await source?.dispose();await provider.close();const report=await runtime.beginClose().completion;expect(report.resourcesReleased).toBe(true);await rm(folder,{recursive:true,force:true});}
},15000);
