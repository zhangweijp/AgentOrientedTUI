import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { catalogState, CATALOG, changed, codeCall, peopleAddress, savedResult, system, TASKS, tool } from './batch-eight-support.mjs';
import { appClient, consoleDeclaration, journal, modelCall, watchUntil } from './batch-two-support.mjs';

export const scopedCall = (id, code, imports, reset = false) => reset
    ? modelCall(id, 'run_code', { code, ...(imports === undefined ? {} : { imports }), reset: true }) : codeCall(id, code, imports);
export const output = result => result.result ?? result;
const email = 'selected@example.test';

async function checkFieldType(consumer, request, fieldType) {
    if (!consumer) return;
    const file = join(consumer, 'actual-scope-' + fieldType + '.ts');
    const other = fieldType === 'number' ? 'string' : 'number';
    await writeFile(file, consoleDeclaration(request) + '\nexport {};\n' +
        'const field = refs.console_catalog.list.people[0].email;\n' +
        'const valid: ' + fieldType + ' = field;\n' +
        '// @ts-expect-error this request has the other field type\nconst invalid: ' + other + ' = field;\n');
    await promisify(execFile)(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'),
        '--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', file]);
    return file;
}

export async function exerciseScope({ turn, namespace, install, runtime, desktop, folder, consumer }) {
    let sequence = 0;
    async function step(label, code, { imports, reset, beforeReply } = {}) {
        const id = namespace + '-' + (++sequence);
        const result = await turn(label, scopedCall(id, code, imports, reset), beforeReply);
        const consoleTools = result.body.tools.filter(entry => entry.function.name === 'run_code');
        assert.equal(consoleTools.length, 1, label);
        assert.match(consoleTools[0].function.description, /Run JavaScript/);
        assert.equal(consoleTools[0].function.parameters.properties.reset.type, 'boolean');
        return { ...result, value: savedResult(result.message, id), id };
    }
    const initial = await step('create scope', 'let x = 1; const readFirst = () => x; const varStr = "请复核";');
    const second = await step('redeclaration shadows first x', 'const x = 2; inspect(x);');
    const third = await step('new x and old closure', 'let x = 3; x += 1; inspect([x, readFirst()]);');
    const fourth = await step('retain last x', 'inspect(x);');
    assert.deepEqual([initial, second, third, fourth].map(part => part.value.output), [[], ['2'], ['[ 4, 1 ]'], ['4']]);
    const failed = await step('initializer fails after mutation', 'x = 6; const readFirst = readFirst();');
    assert.equal(failed.value.code, 'CONSOLE_PROGRAM_FAILED');
    assert.equal(output(failed.value).scope, 'retained');
    const old = await step('recover old binding and mutation', 'inspect([x, readFirst()]); inspect(varStr);');
    assert.deepEqual(old.value.output, ['[ 6, 1 ]', '请复核']);
    const annotation = await step('reject TypeScript source in JS scope', 'const typed: string = 42;');
    assert.equal(annotation.value.code, 'CONSOLE_PROGRAM_FAILED');
    assert.equal(output(annotation.value).scope, 'retained');

    await install();
    for (const app of [CATALOG, TASKS]) {
        const call = system(namespace + '-open-' + app, 'open_app', { installation_id: app });
        const reply = await turn('open ' + app, call);
        const result = savedResult(reply.message, call.id);
        assert.equal(result.app_id, app, JSON.stringify(result));
    }
    const addressText = peopleAddress + '[0].email';
    const current = await step('capture a local email and an old handle',
        'const savedEmail = refs.console_catalog.list.people[0].email; const upper = () => savedEmail.toUpperCase(); ' +
        'const oldTool = tools["console_tasks-workspace-accept"]; const write = literal => tools["console_tasks-workspace-accept"]({items:[],literal}); ' +
        'const partial = refs.console_catalog.list.people; let wake; const background = new Promise(resolve => {wake = resolve}); ' +
        'background.then(async () => { inspect("STALE_OUTPUT"); ' +
        'try { await tools["console_tasks-workspace-accept"]({items:[],literal:"stale callback"}); } catch {} ' +
        'try { await oldTool({items:[],literal:"stale handle"}); } catch {} }); ' +
        'background.then(() => { throw Error("STALE_ASYNC_ERROR"); }); inspect(savedEmail);', { imports: [addressText] });
    assert.deepEqual(current.value.output, [email]);
    const stringTypes = await checkFieldType(consumer, current.body, 'string');
    async function publish(revision, narrowed, field) {
        await catalogState(folder, revision, changed, narrowed, undefined, field);
        await watchUntil(async () => (await appClient(desktop, CATALOG).client.preview()).views?.[0]?.content.value.includes(revision));
    }
    await publish('numeric scope field', false, 41);
    const updated = await step('new number and prior string closure',
        'inspect(typeof savedEmail); inspect(upper()); inspect(typeof refs.console_catalog.list.people[0].email); ' +
        'inspect(refs.console_catalog.list.people[0].email + 1);');
    assert.deepEqual(updated.value.output, ['string', email.toUpperCase(), 'number', '42']);
    const numberTypes = await checkFieldType(consumer, updated.body, 'number');
    const wrong = await step('number cannot use string method', 'inspect(refs.console_catalog.list.people[0].email.toUpperCase());');
    assert.equal(wrong.value.code, 'CONSOLE_PROGRAM_FAILED');
    assert.match(wrong.value.message, /not a function/);

    const refused = await step('revocation during request retains the old locals', 'x = 99; await write("must not execute");', {
        imports: [addressText], beforeReply: () => publish('scope field withdrawn', true, 41),
    });
    assert.equal(refused.value.code, 'REF_VALUE_PRIVATE');
    assert.equal(refused.value.result, undefined);
    assert.deepEqual(await journal(folder, 'writes'), []);
    const closure = system(namespace + '-close-catalog', 'close_app', { app_id: CATALOG });
    const closed = await turn('close source App with retained JSON copy', closure);
    assert.equal(savedResult(closed.message, closure.id).success, true);
    assert.equal(desktop.listApps().find(app => app.installationId === CATALOG).status, 'closed');
    const worker = await journal(folder, 'catalog-life');
    assert.deepEqual(worker.map(entry => entry.event), ['start', 'stop']);

    const fold = system(namespace + '-fold-tasks', 'collapse_app', { app_id: TASKS });
    assert.ok(savedResult((await turn('fold the tasks App', fold)).message, fold.id).success);
    const revoked = await step('withdraw the receiver while keeping local values',
        'try { await oldTool({items:[],literal:"revoked receiver"}); } catch (error) {inspect(error.code);} inspect(savedEmail);');
    assert.ok(!revoked.body.tools.some(entry => entry.function.name === tool('accept')));
    assert.deepEqual(revoked.value.output, ['CONSOLE_TOOL_SCOPE_ENDED', email]);
    assert.deepEqual(revoked.value.subcalls, []);
    assert.deepEqual(await journal(folder, 'writes'), []);
    const expand = system(namespace + '-expand-tasks', 'expand_app', { app_id: TASKS });
    assert.ok(savedResult((await turn('expand the tasks App', expand)).message, expand.id).success);

    const stale = await step('old run callbacks and tool handles stay invalid',
        'wake(); await background; await Promise.resolve(); ' +
        'try { await oldTool({items:[],literal:"old direct handle"}); } catch (error) {inspect(error.code);} ' +
        'try { await tools["console_tasks-workspace-accept"]({items:partial,literal:"bypass partial"}); } catch (error) {inspect(error.message);} ' +
        'inspect(x);', { imports: [] });
    assert.equal(stale.value.output[0], 'CONSOLE_TOOL_SCOPE_ENDED');
    assert.match(stale.value.output[1], /partial Ref/);
    assert.equal(stale.value.output[2], '6');
    assert.deepEqual(stale.value.subcalls, []);
    assert.deepEqual(await journal(folder, 'writes'), []);

    const saved = await step('use the old copy through a fresh tool binding',
        'inspect(Object.keys(refs).length); const result = await write(savedEmail); inspect(result.saved); await write(varStr);', { imports: [] });
    assert.deepEqual(saved.value.output, ['0', 'true']);
    assert.equal(saved.value.subcalls[0].phase, 'entered-returned');
    const native = async (id, literal) => {
        const call = modelCall(namespace + '-' + id.replaceAll(' ', '-'), tool('accept'), { items: [], literal });
        return savedResult((await turn(id, call)).message, call.id);
    };
    assert.equal((await native('native dollar text stays literal', '$varStr')).saved, true);
    assert.deepEqual((await journal(folder, 'writes')).map(row => row.value.literal), [email, '请复核', '$varStr']);
    assert.equal((await native('native escape delivers literal Ref address text', '$' + addressText)).saved, true);
    assert.equal(saved.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === stale.id).length, 1);
    const opened = system(namespace + '-reopen-catalog', 'open_app', { installation_id: CATALOG });
    assert.equal(savedResult((await turn('reopen source under the same App name', opened)).message, opened.id).app_id, CATALOG);
    const reopened = await step('keep the old copy as the source returns', 'inspect(savedEmail); inspect(typeof refs.console_catalog.list.people);');
    assert.deepEqual(reopened.value.output, [email, 'undefined']);
    await step('store an address-like string in a local variable', 'const varStr = ' + JSON.stringify(addressText) + ';');
    const literal = await step('escape a stored address for a program call', 'await write("$" + varStr);');
    assert.equal(literal.value.subcalls[0].phase, 'entered-returned');
    const writes = await journal(folder, 'writes');
    assert.deepEqual(writes.map(row => row.value.literal), [email, '请复核', '$varStr', addressText, addressText]);
    const reset = await step('reset starts a new scope', 'inspect(typeof savedEmail); inspect(typeof x); const marker = "after reset";', { imports: [], reset: true });
    assert.deepEqual(reset.value.output, ['undefined', 'undefined']);
    assert.equal(reset.value.scope, 'reset');
    const persisted = await step('retain a variable defined by reset', 'inspect(marker);');
    assert.deepEqual(persisted.value.output, ['after reset']);
    return { four: [initial, second, third, fourth].map(part => part.value), old: old.value, refused: refused.value,
        current: current.value, updated: updated.value, wrong: wrong.value, revoked: revoked.value, stale: stale.value, reset: reset.value,
        worker, writes, types: { stringTypes, numberTypes } };
}
