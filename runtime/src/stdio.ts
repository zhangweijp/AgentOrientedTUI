#!/usr/bin/env node
import { createInterface } from 'node:readline';
import type { ActiveTurn, AppInvocation, ObservationCandidate, RunningApp, TurnSelection, ViewIdentity } from './index.js';

// Keep the protocol on stdout even when an App logs from its Worker.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const { createRuntime } = await import('./index.js');
const { projectNativeToolSchema } = await import('./adapters/tool-projection.js');
const { projectNativeToolNames } = await import('./adapters/public-tool-name.js');
const runtime = createRuntime();
const desktop = await runtime.createDesktop();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const stop = () => { lines.close(); process.stdin.pause(); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdout.on('error', stop);

const apps = new Map<string, RunningApp>();
const candidates = new Map<string, ObservationCandidate>();
let active: { id: string; turn: ActiveTurn; observations: Set<string> } | undefined;
let turnSequence = 0;
let shuttingDown = false;

type RecordValue = Record<string, unknown>;
function error(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}
function record(value: unknown, label: string): RecordValue {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) error('INVALID_REQUEST', `Provide ${label} as a JSON object.`);
    return value as RecordValue;
}
function text(params: RecordValue, key: string): string {
    const value = params[key];
    if (typeof value !== 'string' || !value.length) error('INVALID_REQUEST', `Provide a non-empty ${key}.`);
    return value;
}
function app(params: RecordValue): RunningApp {
    return apps.get(text(params, 'app')) ?? error('APP_HANDLE_UNAVAILABLE', 'Open or find the expected App instance first.');
}
function turn(params: RecordValue) {
    const id = text(params, 'turn');
    if (active?.id !== id || !active.turn.isCurrent) error('TURN_NOT_ACTIVE', 'Use the currently adopted Desktop turn.');
    return active;
}
function issueFrom(cause: unknown) {
    if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string')
        return { code: cause.code, message: cause.message, ...('path' in cause && typeof cause.path === 'string' ? { path: cause.path } : {}) };
    return { code: 'REQUEST_FAILED', message: 'The Runtime could not complete this request.' };
}
function opened(app: RunningApp) {
    apps.set(app.instanceId, app);
    return { app: app.instanceId, appId: app.appId, instanceId: app.instanceId };
}
function replaceTurn(next?: typeof active) {
    for (const id of active?.observations ?? []) if (!next?.observations.has(id)) candidates.delete(id);
    active = next;
}

function selectApps(params: RecordValue): TurnSelection['apps'] {
    if (!Array.isArray(params.apps)) error('INVALID_REQUEST', 'Provide the complete apps list.');
    return params.apps.map((value: unknown) => {
        const item = record(value, 'an App selection');
        const candidate = candidates.get(text(item, 'candidate'));
        if (!candidate) error('CANDIDATE_UNAVAILABLE', 'Prepare a candidate for this Desktop first.');
        return { candidate, ...(item.windows === undefined ? {} : {
            windows: item.windows as NonNullable<TurnSelection['apps'][number]['windows']>,
        }) };
    });
}

async function dispatch(method: string, params: RecordValue): Promise<unknown> {
    switch (method) {
        case 'desktop': return { id: desktop.id };
        case 'listApps': return desktop.listApps();
        case 'registerApp': return { installationId: await desktop.registerPendingApp({
            installationId: text(params, 'installationId'), localPath: text(params, 'localPath'),
            ...(params.config === undefined ? {} : { config: record(params.config, 'config') }),
        }) };
        case 'openApp': return opened(await desktop.openApp(text(params, 'installationId')));
        case 'getRunningApp': {
            const result = desktop.getRunningApp(text(params, 'appId'), text(params, 'instanceId'));
            return result.status === 'ready' ? { status: 'ready', ...opened(result.app) } : result;
        }
        case 'preview': return app(params).preview();
        case 'observe': {
            const result = await app(params).observe();
            if (result.status === 'rejected') return result;
            const { observation } = result.candidate;
            candidates.set(observation.observationId, result.candidate);
            return { status: 'prepared', candidate: observation.observationId, observation };
        }
        case 'discardObservation': {
            const id = text(params, 'candidate');
            if (active?.observations.has(id)) error('OBSERVATION_IN_USE', 'Release or replace the turn owning this observation.');
            const candidate = candidates.get(id);
            if (!candidate) error('CANDIDATE_UNAVAILABLE', 'Prepare a candidate for this Desktop first.');
            candidates.delete(id);
            return { cleanupIssues: candidate.discard() };
        }
        case 'projectNativeTools': {
            const presented = selectApps(params).map(({ candidate: { observation }, windows }) => {
                if (windows !== undefined && (!Array.isArray(windows?.receiverViews) || !Array.isArray(windows?.refViews)))
                    error('INVALID_REQUEST', 'Provide receiverViews and refViews as arrays.');
                const views = (selection?: readonly ViewIdentity[]) => selection === undefined ? observation.views
                    : observation.views.filter(view => selection.some(target => target?.viewId === view.id &&
                        target.viewInstanceId === view.viewInstanceId));
                const refMounts = new Set(views(windows?.refViews).map(view => view.viewInstanceId));
                return { observation, receivers: views(windows?.receiverViews),
                    refs: observation.refs.filter(ref => refMounts.has(ref.viewInstanceId)) };
            });
            const refs = presented.flatMap(({ observation: { source }, refs }) => refs.map(ref => ({ source, ref })));
            const names = projectNativeToolNames(presented.map(({ observation }) => observation));
            return presented.flatMap(({ observation, receivers }, index) => {
                const projection = names[index]!;
                if (projection.status === 'rejected') {
                    const { code, message, path } = projection.issue;
                    throw Object.assign(new Error(`${observation.source.appId}: ${message}`), { code, path });
                }
                return [...projection.tools].flatMap(([name, tool]) => {
                    const eligible = receivers.filter(view => view.type === tool.viewType &&
                        (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id)))
                        .map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
                    return eligible.length ? [{ observationId: observation.observationId, toolId: tool.id, name,
                        description: tool.description, schema: projectNativeToolSchema(tool, observation.source, eligible, refs) }] : [];
                });
            });
        }
        case 'adoptTurn': {
            const selected = selectApps(params);
            const result = desktop.adoptTurn({ apps: selected });
            if (result.status === 'rejected') return result;
            const id = 'turn-' + ++turnSequence;
            const observations = new Set(selected.map(({ candidate }) => candidate.observation.observationId));
            replaceTurn({ id, turn: result.turn, observations });
            return { status: 'adopted', turn: id, cleanupIssues: result.cleanupIssues };
        }
        case 'invoke': {
            const current = turn(params);
            const running = app(params);
            const observationId = text(params, 'observationId');
            // A closed handle cannot be substituted for the current instance with the same app_id.
            if (candidates.get(observationId)?.observation.source.instanceId !== running.instanceId)
                error('CANDIDATE_UNAVAILABLE', 'Use an observation prepared by this App instance.');
            return current.turn.invoke(running.appId, { observationId, toolId: text(params, 'toolId'),
                invocationId: text(params, 'invocationId'), ...(params.viewId === undefined ? {} : { viewId: text(params, 'viewId') }), input: record(params.input, 'input') as AppInvocation['input'] });
        }
        case 'inspectRef': {
            const mode = text(params, 'mode');
            if (mode !== 'schema' && mode !== 'value') error('INVALID_REQUEST', 'Choose schema or value mode.');
            return turn(params).turn.inspectRef(text(params, 'address'), mode);
        }
        case 'readReceipt': return app(params).readReceipt({ observationId: text(params, 'observationId'), invocationId: text(params, 'invocationId') });
        case 'readDesktopReceipt': return desktop.readReceipt({
            desktopId: text(params, 'desktopId') as typeof desktop.id,
            appId: text(params, 'appId') as RunningApp['appId'],
            instanceId: text(params, 'instanceId'), observationId: text(params, 'observationId'), invocationId: text(params, 'invocationId'),
        });
        case 'releaseTurn': {
            const result = { cleanupIssues: turn(params).turn.release() };
            replaceTurn();
            return result;
        }
        case 'getAppWindows': {
            const { appId, instanceId } = app(params);
            return desktop.getAppWindows(appId, instanceId) ?? null;
        }
        case 'revokeWindowAccess': {
            const current = turn(params);
            const { appId, instanceId } = app(params);
            const target = params.viewId === undefined && params.viewInstanceId === undefined ? { appId, instanceId }
                : { appId, instanceId, viewId: text(params, 'viewId'), viewInstanceId: text(params, 'viewInstanceId') };
            desktop.revokeWindowAccess(current.turn, target);
            return null;
        }
        case 'closeView': {
            const current = turn(params);
            const { appId, instanceId } = app(params);
            return desktop.closeView({ appId, instanceId, viewId: text(params, 'viewId'),
                viewInstanceId: text(params, 'viewInstanceId') }, current.turn);
        }
        case 'closeApp': {
            const running = app(params);
            const report = await running.beginClose().completion;
            if (report.resourcesReleased) apps.delete(running.instanceId);
            for (const [id, candidate] of candidates) if (candidate.observation.source.instanceId === running.instanceId) candidates.delete(id);
            return report;
        }
        case 'shutdown': {
            const report = await runtime.beginClose().completion;
            shuttingDown = report.resourcesReleased;
            return report;
        }
        default: return error('METHOD_NOT_FOUND', 'Unknown Runtime stdio method.');
    }
}

async function respond(line: string) {
    let id: string | number | null = null;
    let payload: { result: unknown } | { error: ReturnType<typeof issueFrom> };
    try {
        // The Runtime enforces its App-specific budgets as well.
        if (Buffer.byteLength(line) > 1024 * 1024) error('INVALID_REQUEST', 'A request may use at most 1 MiB of JSON.');
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { error('INVALID_JSON', 'Supply one JSON request per line.'); }
        const request = record(parsed, 'request');
        if (typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) error('INVALID_REQUEST', 'Provide a string or integer request id.');
        id = request.id as string | number;
        const method = text(request, 'method');
        payload = { result: await dispatch(method, request.params === undefined ? {} : record(request.params, 'params')) };
    } catch (cause) { payload = { error: issueFrom(cause) }; }
    await new Promise<void>((resolve, reject) => protocolWrite(JSON.stringify({ id, ...payload }) + '\n', cause => cause ? reject(cause) : resolve()));
}

try {
    for await (const line of lines) {
        await respond(line);
        if (shuttingDown) break;
    }
} catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'EPIPE')) throw cause;
} finally {
    stop();
    const report = await runtime.beginClose().completion;
    if (!report.ok || !report.resourcesReleased) {
        console.error('Runtime shutdown incomplete', report);
        process.exitCode = 1;
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.stdout.off('error', stop);
}
