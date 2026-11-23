import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fixtureAppPath, appClient, journal, modelCall, watchUntil } from './batch-two-support.mjs';

export const CATALOG = 'console_catalog', TASKS = 'console_tasks';
export const original = [
    { title: 'original-first', done: false }, { title: 'original-second', done: true },
    { title: 'original-first', done: false },
];
export const changed = [original[1], original[0]];
const email = 'selected@example.test';
export const codeCall = (id, code, imports) => modelCall(id, 'run_code', { code, ...(imports === undefined ? {} : { imports }) });
export const itemAddress = '$console_catalog.list.todos';
export const peopleAddress = '$console_catalog.list.people';

export async function catalogState(folder, revision, todos = original, narrowed = false, padding, field = undefined) {
    const file = join(folder, 'catalog.json');
    await writeFile(file + '.next', JSON.stringify({ revision, todos, narrowed, padding, people: [
        { email: field ?? (revision === 'original' ? email : 'updated@example.test'), phone: 'SYNTHETIC_PHONE_NEVER_PUBLISHED' },
        { email: typeof field === 'number' ? field + 1 : 'sibling@example.test', phone: 'SYNTHETIC_SIBLING_PHONE' },
    ] }));
    await rename(file + '.next', file);
}

export async function installConsoleFixtures(desktop, consumer, folder) {
    await mkdir(folder, { recursive: true });
    await catalogState(folder, 'original');
    for (const [app, fixture] of [[CATALOG, 'catalog'], [TASKS, 'tasks']]) {
        const localPath = await fixtureAppPath(join(consumer, 'dist', 'batch-eight-' + fixture + '.js'), app, folder);
        await desktop.registerPendingApp({ installationId: app, localPath, config: { folder } });
    }
}

export function consolePolicy(hooks, grantEmail) {
    return {
        project: ({ source }) => ({
            refs: Object.values(source.refs).flatMap(ref => {
                if (ref.id === 'people' && grantEmail) return grantEmail(source).refs;
                return [{ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
                    ...(ref.id === 'people' ? { paths: [{ path: [0, 'email'], consumer: 'console' }] } : {}) }];
            }),
            toolIds: Object.keys(source.tools),
        }),
        authorize: context => {
            hooks.authorized.push({ ...context, signal: undefined });
            return hooks.authorize?.(context) ?? true;
        },
        canReadReceipt: receipt => { hooks.receipts.push(receipt);return true; },
    };
}

export function attachConsolePolicy(runtime, hooks) {
    const get = runtime.getAppInteraction.bind(runtime);
    const policy = consolePolicy(hooks);
    runtime.getAppInteraction = (desktop, app, instance, supplied) => get(desktop, app, instance, supplied ?? policy);
}

export const system = (id, name, args) => modelCall(id, 'system-' + name, args);
export const tool = (name) => TASKS + '-' + name;
const names = body => body.tools.map(entry => entry.function.name);
export const sdkDescription = body => body.tools.find(entry => entry.function.name === 'run_code')?.function.description;
export function savedResult(message, id) {
    assert.equal(message.role, 'tool');
    assert.equal(message.content.length, 1);
    assert.equal(message.content[0].toolCallId, id);
    return message.content[0].output.value;
}
function output(result) { return result.result ?? result; }

export async function strictGeneratedTypes(consumer, body, prefix, hasDetail = false) {
    const description = sdkDescription(body);
    const declaration = description.slice(description.indexOf('type JsonValue ='));
    const source = join(consumer, prefix + '-declaration.ts');
    await writeFile(source, declaration + '\n' + [
        'export {};',
        'const email: string = refs.console_catalog.list.people[0].email;',
        'const priority: number = refs.console_tasks.workspace.values[0]!.priority;',
        'await tools["console_tasks-accept"]({items:refs.console_catalog.list.todos,literal:email,meta:[3,null]});',
        'await tools["console_tasks-accept"]({items:[{title:"manual",done:true}],literal:email});',
        'await tools["console_tasks-select"]({item:"$console_catalog.list.todos[0]",items:["$console_catalog.list.todos[1]"]});',
        'try { await tools["console_tasks-select"]({item:"$console_catalog.list.todos[0]"}); } catch (error) {',
        '  if (error instanceof ToolCallError) {',
        '    const toolName: keyof typeof tools = error.toolName;',
        '    const name: "ToolCallError" = error.name;',
        '    inspect(toolName, name, error.code, error.message);',
        '    // @ts-expect-error only actual business Tool names qualify',
        '    const systemTool: typeof error.toolName = "run_code";',
        '  }',
        '}',
        '// @ts-expect-error phone was not granted',
        'refs.console_catalog.list.people[0].phone;',
        '// @ts-expect-error the partial rows record has no length',
        'refs.console_catalog.list.people.length;',
        '// @ts-expect-error other index not granted',
        'refs.console_catalog.list.people[1];',
        '// @ts-expect-error partial index record is not a business array',
        'await tools["console_tasks-accept"]({items:refs.console_catalog.list.people,literal:email});',
        '// @ts-expect-error another Todo label does not determine the structure',
        'refs.console_tasks.workspace.values[0]!.title;',
        '// @ts-expect-error items without a source schema are unknown',
        'const unknownTitle: string = refs.console_catalog.list.loose[0].title;',
        '// @ts-expect-error whole observed array is readonly',
        'refs.console_catalog.list.todos.push({title:"no",done:true});',
        '// @ts-expect-error an ordinary object cannot claim nominal Ref provenance',
        'await tools["console_tasks-select"]({item:{title:"manual",done:true}});',
        '// @ts-expect-error nominal address requires the dollar prefix',
        'await tools["console_tasks-select"]({item:"console_catalog.list.todos[0]"});',
        '// @ts-expect-error single-instance tools have no view_id parameter',
        'await tools["console_tasks-accept"]({items:[],literal:email,view_id:"workspace"});',
        '// @ts-expect-error tuple first element must be numeric',
        'await tools["console_tasks-accept"]({items:[],literal:email,meta:["bad",null]});',
        '// @ts-expect-error unsupported structural constraint leaves the native Tool only',
        'tools["console_tasks-native_only"];',
        ...(hasDetail ? [
            'await tools["console_tasks-edit"]({view_id:"detail_1",value:email});',
            '// @ts-expect-error multiple-instance edit requires view_id',
            'await tools["console_tasks-edit"]({value:email});',
        ] : ['// @ts-expect-error the editor was not open in this request', 'tools["console_tasks-edit"];']),
    ].join('\n') + '\n');
    await promisify(execFile)(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'),
        '--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--noEmit', '--target', 'ES2022',
        '--module', 'NodeNext', source], { cwd: consumer });
    return source;
}

export async function exerciseConsole({ turn, install, runtime, desktop, folder, hooks, declarationFolder, receipt, scoped = false }) {
    const summary = {};
    const step = async (label, call, beforeReply) => {
        const turnResult = await turn(label, call, beforeReply);
        assert.equal(names(turnResult.body).filter(x => x === 'run_code').length, 1, label);
        return { body: turnResult.body, message: turnResult.message, result: savedResult(turnResult.message, call.id) };
    };
    const arithmetic = await step('arithmetic', codeCall('arithmetic', scoped ? 'const n = 1 + 2; inspect(n)' : 'const n: number = 1 + 2; inspect(n)'));
    assert.deepEqual(arithmetic.result.output, ['3']);
    assert.equal(arithmetic.body.messages.some(message => message.role === 'user' && typeof message.content === 'string' &&
        (message.content.startsWith('<view ') || message.content.includes('- installation_id:'))), false);
    const ephemeral = await step('ephemeral', codeCall('ephemeral', 'inspect(typeof n)'));
    assert.deepEqual(ephemeral.result.output, [scoped ? 'number' : 'undefined']);
    assert.equal(ephemeral.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'arithmetic').length, 1);
    await install();
    const catalog = await step('open catalog', system('open-catalog', 'open_app', { installation_id: CATALOG }));
    const task = await step('open tasks', system('open-tasks', 'open_app', { installation_id: TASKS }));
    assert.equal(catalog.result.app_id, CATALOG, JSON.stringify(catalog.result));
    assert.equal(task.result.app_id, TASKS, JSON.stringify(task.result));
    const cross = await step('original value and two children', codeCall('cross',
        'const x = refs.console_catalog.list; ' +
        'const stored = await tools["console_tasks-accept"]({items:x.todos,literal:"$console_catalog.list.todos",meta:[2,null]}); ' +
        'await tools["console_tasks-select"]({item:"$console_catalog.list.todos[0]",items:["$console_catalog.list.todos[1]","$console_catalog.list.todos[0]","$console_catalog.list.todos[1]"]}); ' +
        'inspect(x.people[0].email);'), async () => {
        await catalogState(folder, 'changed', changed);
        await watchUntil(async () => {
            const view = await appClient(runtime, desktop, CATALOG).client.preview();
            return view.status === 'previewed' && view.views[0].content.value.includes('changed');
        });
    });
    assert.deepEqual(cross.result.output, [email]);
    assert.deepEqual(cross.result.subcalls.map(call => call.phase), ['entered-returned', 'entered-returned']);
    assert.equal(JSON.stringify(cross.result).includes('TOOL_DATA_NOT_INSPECTED'), false);
    const witnesses = await journal(folder, 'writes');
    assert.deepEqual(witnesses.map(row => row.value), [
        { items: original, literal: itemAddress, meta: [2, null] },
        { item: original[0], items: [original[1], original[0], original[1]] },
    ]);
    const declaration = sdkDescription(cross.body);
    assert.match(declaration, /console_tasks-native_only.+\$.properties.constant.const/);
    assert.ok(names(cross.body).includes(tool('native_only')));
    for (const hidden of ['phone', 'private_rows', 'team_rows']) assert.equal(declaration.includes(hidden), false);
    assert.equal(JSON.stringify(cross.body).includes('SYNTHETIC_PHONE_NEVER_PUBLISHED'), false);
    assert.ok(!names(cross.body).includes(tool('edit')));
    if (declarationFolder) summary.strict = await strictGeneratedTypes(declarationFolder, cross.body, 'actual-b8');
    summary.cross = { result: cross.result, writes: witnesses };

    const selected = await step('empty and explicit imports', codeCall('empty-imports', 'inspect(Object.keys(refs).length);', []));
    assert.deepEqual(selected.result.output, ['0']);
    const nativeField = await step('native tool cannot use a Console-only grant', modelCall('native-console-only', tool('accept'),
        { items: [], literal: peopleAddress + '[0].email' }));
    assert.match(nativeField.result.code, /^REF_/);
    const attempt = 'inspect("must not run"); await tools["console_tasks-accept"]({items:[],literal:"must not dispatch"});';
    const rejected = [];
    for (const [label, address] of [['parent', peopleAddress], ['sibling', peopleAddress + '[0].phone'],
        ['private', '$console_catalog.list.private_rows'], ['protected', '$console_catalog.list.team_rows']]) {
        const response = await step('forbidden ' + label, codeCall('forbidden-' + label, attempt, [address]));
        assert.equal(response.result.code, 'CONSOLE_REF_UNAVAILABLE');
        assert.equal(response.result.result, undefined);
        rejected.push({ label, result: response.result });
    }
    const excess = await step('too many imports', codeCall('excess', attempt, Array(257).fill(itemAddress)));
    assert.equal(excess.result.code, 'CONSOLE_INVALID_INPUT');
    assert.equal(excess.result.result, undefined);
    async function moveScope(label, narrowed) {
        await catalogState(folder, label, changed, narrowed);
        await watchUntil(async () => {
            const view = await appClient(runtime, desktop, CATALOG).client.preview();
            return view.status === 'previewed' && view.views[0].content.value.includes(label);
        });
    }
    for (const [label, imports] of [['default', undefined], ['explicit', [peopleAddress + '[0].email']],
        ['empty', []], ['other field', [itemAddress + '[0].title']]]) {
        const code = label === 'empty' ? 'inspect(Object.keys(refs).length);' : label === 'other field'
            ? 'inspect(refs.console_catalog.list.todos[0].title); inspect(typeof refs.console_catalog.list.people);' : attempt;
        const id = 'scope-' + label.replaceAll(' ', '-');
        const narrowed = await step('publish scope revoked with ' + label + ' imports', codeCall(id, code, imports), () => moveScope(id, true));
        assert.match(sdkDescription(narrowed.body), /readonly email: string/);
        if (label === 'empty') assert.deepEqual(narrowed.result.output, ['0']);
        else if (label === 'other field') assert.deepEqual(narrowed.result.output, [changed[0].title, 'undefined']);
        else {
            assert.equal(narrowed.result.code, 'CONSOLE_REF_UNAVAILABLE');
            assert.equal(narrowed.result.result, undefined);
        }
        assert.equal((await journal(folder, 'writes')).length, 2);
        rejected.push({ label: 'narrowed / ' + label, result: narrowed.result });
        await moveScope('restored ' + id, false);
    }
    const malformed = await step('no nominal origin', codeCall('bad-address', 'for (const item of ' + JSON.stringify([
        '$console_tasks.workspace.values[0]', '$console_catalog.list.other_kind[0]', '$console_catalog.list.todos[99]',
    ]) + ') { try { await tools["console_tasks-select"]({item}); } catch (error) { inspect(error.code); } }'));
    assert.equal(malformed.result.subcalls.length, 3);
    assert.ok(malformed.result.subcalls.every(call => call.phase === 'not-dispatched'));
    summary.rejections = [...rejected, { label: 'Console-only Path', result: nativeField.result }, { label: 'capacity', result: excess.result },
        { label: 'nominal addresses', result: malformed.result }];
    const partial = await step('forbid synthesized containers', codeCall('partial', 'await tools["console_tasks-accept"]({items:refs.console_catalog.list.people,literal:"bad"})'));
    assert.equal(partial.result.code, 'CONSOLE_PROGRAM_FAILED');
    assert.deepEqual(output(partial.result).subcalls, []);
    const nonJson = await step('forbid non-JSON objects', codeCall('non-json', 'await tools["console_tasks-accept"]({items:[],literal:"bad",meta:new Date()})'));
    assert.match(nonJson.result.message, /plain JSON/);
    assert.deepEqual(output(nonJson.result).subcalls, []);
    assert.equal((await journal(folder, 'writes')).length, 2);
    const cases = [tool('select'), tool('accept')];
    const opening = await step('handle child errors then open detail from program', codeCall('open-detail',
        'for (const name of ' + JSON.stringify(cases) + ') { try { await tools[name]({}); } catch (error) { ' +
        'if (!(error instanceof ToolCallError) || !(error instanceof Error)) throw error; ' +
        'inspect(JSON.stringify({name:error.name,toolName:error.toolName,code:error.code,message:error.message})); }} ' +
        'await tools["console_tasks-open"]({}); inspect(typeof tools["console_tasks-edit"]);'));
    const [one, two, lastOutput] = opening.result.output;
    assert.equal(lastOutput, 'undefined');
    const toolErrors = [JSON.parse(one), JSON.parse(two)];
    assert.deepEqual(toolErrors.map(error => [error.name, error.toolName, error.code]), cases.map(name => ['ToolCallError', name, 'TOOL_INVALID_ARGS']));
    assert.ok(toolErrors.every(error => error.message.includes('Required parameter')));
    assert.deepEqual(opening.result.subcalls.map(call => call.phase), ['not-dispatched', 'not-dispatched', 'entered-returned']);
    summary.toolErrors = { toolErrors, result: opening.result };
    assert.ok(!names(opening.body).includes(tool('edit')));
    const next = await step('new detail tool', codeCall('detail',
        'await tools["console_tasks-edit"]({view_id:"detail_1",value:"$original literal"});'));
    assert.ok(names(next.body).includes(tool('edit')));
    assert.equal(next.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'open-detail').length, 1);
    assert.match(sdkDescription(next.body), /"console_tasks-edit".+view_id: string/);
    if (declarationFolder) summary.detailStrict = await strictGeneratedTypes(declarationFolder, next.body, 'actual-b8-edit', true);
    const native = await step('unsupported schema stays native', modelCall('native-only', tool('native_only'), { constant: { mark: 'native' } }));
    assert.equal(native.result.saved, true);

    const authorization = Promise.withResolvers(), allow = Promise.withResolvers();
    hooks.authorize = async context => {
        if (context.effectiveInput.literal !== 'withdraw') return true;
        authorization.resolve();
        await allow.promise;
        return true;
    };
    const withdrawnWork = step('revoke before dispatch', codeCall('withdraw',
        'await tools["console_tasks-accept"]({items:[],literal:"withdraw"});'));
    await Promise.race([authorization.promise, withdrawnWork.then(result => { throw new Error(JSON.stringify(result.result)); })]);
    const tasks = appClient(runtime, desktop, TASKS).app;
    try { await desktop.collapseApp(TASKS, tasks.appInstanceId, 'fixture withdrawn'); }
    finally { allow.resolve(); }
    const withdrawn = await withdrawnWork;
    hooks.authorize = undefined;
    assert.equal(output(withdrawn.result).subcalls[0].phase, 'not-dispatched');
    assert.equal((await journal(folder, 'writes')).length, 4);
    const collapsed = await step('collapsed keeps console', codeCall('still-console', 'inspect(typeof tools["console_tasks-edit"]);'));
    assert.deepEqual(collapsed.result.output, ['undefined']);
    await desktop.expandApp(TASKS, tasks.appInstanceId);

    const stale = await step('do not rebind same name', codeCall('stale', attempt), async () => {
        const old = appClient(runtime, desktop, CATALOG).app;
        await desktop.closeApp(CATALOG, old.appInstanceId);
        assert.equal(await desktop.openApp(CATALOG), CATALOG);
        assert.notEqual(appClient(runtime, desktop, CATALOG).app.appInstanceId, old.appInstanceId);
    });
    assert.equal(stale.result.code, 'CONSOLE_REF_UNAVAILABLE');
    assert.equal(stale.result.result, undefined);
    assert.equal((await journal(folder, 'writes')).length, 4);
    summary.reopened = stale.result;
    const truncated = await step('bounded output and first error', codeCall('truncate',
        'inspect("before"); inspect("x".repeat(10000)); throw Error("first error")'));
    assert.equal(truncated.result.code, 'CONSOLE_PROGRAM_FAILED');
    assert.equal(truncated.result.message, 'first error');
    assert.equal(output(truncated.result).truncated, true);
    assert.equal(output(truncated.result).output[0], 'before');

    await writeFile(join(folder, 'park'), '');
    try {
        const late = await step('keep admitted child', codeCall('late',
            'const first = tools["console_tasks-accept"]({items:[],literal:"park"}); ' +
            'const second = tools["console_tasks-accept"]({items:[],literal:"must not start"}); await Promise.all([first,second]);'));
        assert.equal(late.result.code, 'CONSOLE_TIMEOUT');
        const subcalls = output(late.result).subcalls;
        assert.equal(subcalls[0].phase, 'unknown');
        assert.equal(subcalls[1].phase, 'not-dispatched');
        assert.deepEqual((await journal(folder, 'writes')).map(row => row.label), ['accept', 'select', 'edit', 'native_only', 'accept']);
        await unlink(join(folder, 'park'));
        const settlement = await receipt(late.message, 'late', subcalls[0].invocationId);
        assert.equal(settlement.kind, 'receipt');
        assert.equal(settlement.receipt.outcome.status, 'succeeded');
        assert.equal(settlement.receipt.invocationId, subcalls[0].invocationId);
        summary.late = { result: late.result, settlement };
    } finally { await unlink(join(folder, 'park')).catch(() => {}); }
    await step('close catalog', system('close-catalog', 'close_app', { app_id: CATALOG }));
    await step('close tasks', system('close-tasks', 'close_app', { app_id: TASKS }));
    const last = await step('closed all and no replay', codeCall('no-refs', 'inspect(Object.keys(refs).length);'));
    assert.deepEqual(last.result.output, ['0']);
    assert.equal((await journal(folder, 'writes')).length, 5);
    summary.close = { result: last.result, catalog: await journal(folder, 'catalog-life'), tasks: await journal(folder, 'tasks-life') };
    assert.deepEqual(summary.close.catalog.map(row => row.event), ['start', 'stop', 'start', 'stop']);
    assert.deepEqual(summary.close.tasks.map(row => row.event), ['start', 'stop']);
    assert.equal(summary.close.catalog[0].threadId, summary.close.catalog[1].threadId);
    assert.notEqual(summary.close.catalog[0].threadId, summary.close.catalog[2].threadId);
    return summary;
}
