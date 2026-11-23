import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { functions, healthyLog, views } from './batch-fourteen-schema.mjs';
import { journal, modelCall } from './batch-two-support.mjs';
import { savedParts } from './batch-ten-delivery.mjs';

const programme = '$theatre.programme.when';
const ticket = '$theatre.form.ticket';
const program = (id, code, imports = null, reset = false) => modelCall(id, 'run_code', { code, imports, reset });
const effects = manifest => journal(dirname(manifest.modulePath), 'policy-effects');
const text = body => body.messages.filter(item => item.role === 'user').map(item => item.content).join('\n');

export const setPolicyScenario = (manifest, mode) => writeFile(join(dirname(manifest.modulePath), 'schema-case.txt'), mode);

export function assertStrictConsole(body, scoped = true) {
    const declarations = body.tools.map(item => item.function ?? item).filter(item => item.name === 'run_code');
    assert.equal(declarations.length, 1);
    const [tool] = declarations, schema = tool.parameters;
    assert.equal(tool.strict, true);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, scoped ? ['code', 'imports', 'reset'] : ['code', 'imports']);
    assert.equal('reset' in schema.properties, scoped);
    assert.equal(schema.properties.code.pattern, '[\\s\\S]');
    assert.deepEqual(schema.properties.imports.anyOf, [{ type: 'array', maxItems: 256, items: { type: 'string' } }, { type: 'null' }]);
    return tool;
}

export async function exerciseEmptyConsole(turn, scoped = true) {
    const inputs = scoped ? [
        program('empty-define', 'const total = 1 + 2; inspect(total)'),
        program('empty-keep', 'inspect(total)', []),
        program('empty-reset', 'inspect(typeof total)', null, true),
    ] : [modelCall('empty-one-shot', 'run_code', { code: 'inspect(1 + 2)', imports: null })];
    const facts = [];
    for (const [index, request] of inputs.entries()) {
        const calls = [request];
        const { body, message } = await turn(`empty-${index}`, calls);
        const tool = assertStrictConsole(body, scoped);
        assert.match(tool.description, /declare const tools: \{\s*\};/);
        assert.ok(!tool.description.includes('readonly theatre:'));
        const result = savedParts(message, calls)[0].output;
        assert.equal(result.type, 'json');
        assert.deepEqual(result.value.output, [index === 2 ? 'undefined' : '3']);
        facts.push(result.value.output);
    }
    const invalid = scoped ? [modelCall('empty-omit', 'run_code', { code: 'inspect(99)', reset: false }),
        program('empty-blank', ' \n\t'), program('empty-over-limit', 'inspect(99)', Array(257).fill(programme))]
        : [modelCall('one-shot-extra-reset', 'run_code', { code: 'inspect(99)', imports: null, reset: false })];
    const rejected = await turn('empty-invalid', invalid);
    for (const { output } of savedParts(rejected.message, invalid)) {
        assert.equal(output.type, 'error-json');
        assert.equal(output.value.code, 'CONSOLE_INVALID_INPUT');
    }
    const { body } = await turn('empty-paired', []);
    if (body.messages) for (const { id } of [...inputs, ...invalid])
        assert.equal(body.messages.filter(part => part.role === 'tool' && part.tool_call_id === id).length, 1);
    else for (const { id } of [...inputs, ...invalid])
        assert.equal(body.input.filter(part => part.type === 'function_call_output' && part.call_id === id).length, 1);
    return facts;
}

export async function exercisePolicyWindows(turn, desktop, captured, manifest, twins = false) {
    const admissions = captured.events.length, writes = (await effects(manifest)).length;
    const collapse = (id, view_id, note) => modelCall(id, 'system-collapse_view', { app_id: 'theatre', view_id, note });
    const expand = (id, view_id) => modelCall(id, 'system-expand_view', { app_id: 'theatre', view_id });
    const read = modelCall('read-programme', 'theatre-read_program', {});
    const fold = [collapse('fold-form', 'form', 'Get tickets later')];
    const called = await turn('policy-fold', fold);
    assert.ok(!functions(called.body)['theatre-pick'] && functions(called.body)['healthy-confirm']);
    assert.deepEqual(captured.events.slice(admissions).map(item => item.appId), ['healthy']);
    assert.equal(savedParts(called.message, fold)[0].output.value.success, true);
    if (twins) {
        const start = captured.events.length;
        const more = [modelCall('healthy-while-annex-open', 'healthy-confirm', { text: 'Annex still open' }), collapse('fold-annex', 'annex', 'Later')];
        const active = await turn('policy-annex-open', more);
        assert.ok(text(active.body).includes('cannot encode theatre-pick'));
        assert.ok(views(active.body).every(view => !view.includes('app_id="theatre"')));
        assert.ok(!functions(active.body)['theatre-read_program']);
        assert.equal(savedParts(active.message, more)[0].output.value.confirmed, true);
        assert.equal(savedParts(active.message, more)[1].output.value.success, true);
        assert.deepEqual(captured.events.slice(start).map(item => item.appId), ['healthy']);
    }
    const allowed = await turn('policy-readable', [read]);
    const tools = functions(allowed.body), content = views(allowed.body);
    assert.ok(tools['theatre-read_program'] && !tools['theatre-pick']);
    assert.ok(content.some(view => view.includes('view_id="form"') && view.includes('Get tickets later')));
    assert.ok(content.some(view => view.includes('view_id="programme"') && view.includes('Tonight at 20:00')));
    assert.ok(!content.some(view => view.includes(ticket)));
    assert.ok(!assertStrictConsole(allowed.body).description.includes('"theatre-pick"'));
    assert.equal(savedParts(allowed.message, [read])[0].output.value.ok, true);
    const attempt = [expand('try-unencodable-window', 'form')];
    const refused = await turn('policy-expand-form', attempt);
    const denied = savedParts(refused.message, attempt)[0].output.value;
    assert.equal(denied.code, 'MODEL_TOOL_SCHEMA_UNSUPPORTED');
    assert.ok(denied.message.includes('theatre-pick') && denied.message.includes('prefixItems'));
    const app = desktop.getInstalledApps().find(item => item.appId === 'theatre');
    const windows = () => desktop.getAppWindows(app.appId, app.appInstanceId).views;
    assert.equal(windows().find(view => view.viewId === 'form').note, 'Get tickets later');
    const defaults = [program('with-default', 'inspect(refs.theatre.programme.when); await tools["theatre-read_program"]({});'),
        program('with-empty', 'inspect(Object.keys(refs).length)', [])];
    const input = await turn('policy-console-inputs', defaults);
    const [keep, empty] = savedParts(input.message, defaults).map(part => part.output.value);
    assert.ok(keep.output[0].includes('Tonight at 20:00'));
    assert.equal(keep.subcalls.length, 1);
    assert.equal(keep.subcalls[0].phase, 'entered-returned');
    assert.deepEqual(empty.output, ['0']);
    const revoked = [collapse('fold-programme', 'programme', 'Wait for the show'),
        program('default-revoked', 'await tools["theatre-read_program"]({});'),
        program('explicit-revoked', 'inspect(refs.theatre.programme.when)', [programme]),
        program('empty-still-valid', 'inspect(Object.keys(refs).length)', [])];
    const revocation = await turn('policy-revoked', revoked);
    const output = savedParts(revocation.message, revoked).map(part => part.output);
    for (const error of output.slice(1, 3)) {
        assert.equal(error.type, 'error-json');
        assert.match(error.value.code, /^(REF_|CONSOLE_)/);
    }
    assert.deepEqual(output[3].value.output, ['0']);
    const resume = [expand('restore-programme', 'programme')];
    const expanded = await turn('policy-expand-programme', resume);
    assert.equal(savedParts(expanded.message, resume)[0].output.value.success, true);
    assert.equal(windows().find(view => view.viewId === 'programme').note, undefined);
    const latest = await turn('policy-restored', []);
    assert.ok(views(latest.body).some(view => view.includes('Tonight at 20:00')));
    assert.ok(functions(latest.body)['theatre-read_program']);
    for (const call of [...defaults, ...revoked])
        assert.equal(latest.body.messages.filter(part => part.role === 'tool' && part.tool_call_id === call.id).length, 1);
    const form = windows().find(view => view.viewId === 'form');
    await desktop.expandView({ appId: app.appId, instanceId: app.appInstanceId, viewId: form.viewId, viewInstanceId: form.viewInstanceId });
    const alone = [modelCall('healthy-after-unfold', 'healthy-confirm', { text: 'The form was expanded outside the request' })];
    const start = captured.events.length;
    const reopened = await turn('policy-host-unfold', alone);
    assert.ok(text(reopened.body).includes('cannot encode theatre-pick'));
    assert.ok(views(reopened.body).every(view => !view.includes('app_id="theatre"')));
    assert.deepEqual(captured.events.slice(start).map(item => item.appId), ['healthy']);
    assert.equal(savedParts(reopened.message, alone)[0].output.value.confirmed, true);
    const after = (await effects(manifest)).slice(writes);
    assert.deepEqual(after.map(item => item.tool), ['read_program', 'read_program']);
    return { twins, effects: after, notes: windows(), inputs: [keep.output, empty.output], rejected: output.slice(1, 3) };
}

export async function exerciseStationBudget(turn, mode, manifest, healthy, captured, strict = true) {
    const before = captured.events.length, start = (await effects(manifest)).length, healthyStart = (await healthyLog(healthy)).length;
    const works = mode === 'at' || !strict;
    const calls = [modelCall('healthy-route', 'healthy-confirm', { text: mode })];
    if (works) calls.push(...(mode === 'at' ? [modelCall('at-boundary', 'theatre-at_limit', { station: 'S0999' }),
        modelCall('split-boundary', 'theatre-split_at_limit', { from: 'S0499', to: 'S0499' })]
        : [modelCall('ordinary-pick', 'theatre-over_limit', { station: 'S1000' })]));
    const received = await turn(`stations-${mode}-${strict ? 'strict' : 'ordinary'}`, calls);
    const tools = functions(received.body);
    assert.ok(tools['system-open_app'] && tools['system-close_app'] && tools['healthy-confirm']);
    const admitted = captured.events.slice(before).map(event => event.appId).sort();
    assert.deepEqual(admitted, works ? ['healthy', 'theatre'] : ['healthy']);
    const counts = Object.entries(tools).filter(([name]) => name.startsWith('theatre-')).map(([, tool]) =>
        Object.values(tool.parameters.properties).reduce((total, param) => total + (param.anyOf?.[0]?.enum?.length ?? 0), 0));
    assert.deepEqual(counts, mode === 'at' ? [1000, 1000] : works ? [1001] : []);
    if (!works) {
        const issue = text(received.body), field = mode === 'over' ? 'station' : 'to';
        assert.ok(issue.includes(`$.properties.${field}.anyOf[0].enum`) && issue.includes('1001') && issue.includes('1000'), issue);
        assert.ok(!views(received.body).some(view => view.includes('app_id="theatre"')));
        assert.ok(!tools.run_code.description.includes('"theatre-'));
    }
    const results = savedParts(received.message, calls);
    assert.ok(results.every(result => result.output.type === 'json'));
    assert.deepEqual((await healthyLog(healthy)).slice(healthyStart), [{ text: mode }]);
    const handlers = (await effects(manifest)).slice(start);
    assert.equal(handlers.length, calls.length - 1);
    return { admitted, counts, handlers };
}
