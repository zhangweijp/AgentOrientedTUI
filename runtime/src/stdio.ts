#!/usr/bin/env node
import { createInterface } from 'node:readline';
import type { ActiveTurn, CandidateScope, InteractionIssue, ObservationCandidate,
    ProjectionLimitOverrides, InteractionLimitOverrides, ObservationOptions, RunningApp, TurnSelection, UpdateSignal } from './index.js';

// Keep the protocol on stdout even when an App logs from its Worker.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const { createRuntime } = await import('./index.js');
const { projectDesktop, routeNativeInvocation, DESKTOP_TOOL_NAMES, captureSystemInput, inspectRefSchema } = await import('./adapters/index.js');
import type { DesktopCapability, NativeTool, ViewPresentation } from './adapters/index.js';
const { readRuntimeProtocolIssue } = await import('./adapters/initialization-error.js');
const { canonicalJson, utf8Size } = await import('@aotui/core');
const runtime = createRuntime();
const desktop = await runtime.createDesktop();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let inputStopped = false;
function stop() {
    if (inputStopped) return;
    inputStopped = true;
    lines.close();
    process.stdin.pause();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdout.on('error', outputFailed);

const protocol = 'aotui-stdio';
const majorVersion = 2;
const outputEvents = 'output-events';
const commandApps = 'command-apps';
const supportedCapabilities = [outputEvents, commandApps];
const subscribed = new Map<string, string>();
let capabilities: ReadonlySet<string> | undefined;
const apps = new Map<string, RunningApp>();
const candidates = new Map<string, ObservationCandidate>();
interface StdioScope {
    scope: CandidateScope;
    observed: Set<string>;
    presentation?: { id: number; apps: TurnSelection['apps']; tools: readonly NativeTool[] };
}
const scopes = new Map<string, StdioScope>();
let presentationSequence = 0;
let scopeSequence = 0;
let active: { id: string; turn: ActiveTurn; observations: Set<string>; tools: readonly NativeTool[] } | undefined;
let turnSequence = 0;
let closing = false;
let outputBroken = false;
let lastWrite = Promise.resolve();

type RecordValue = Record<string, unknown>;
type RequestId = string | number;
type ErrorWithCause = Partial<InteractionIssue> & { readonly cause?: unknown };
const requests = new Set<RequestId>();
function error(code: string, message: string, path?: string): never {
    throw Object.assign(new Error(message), { code, ...(path === undefined ? {} : { path }) });
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
    return appHandle(text(params, 'app'));
}
function appHandle(handle: string): RunningApp {
    return apps.get(handle) ?? error('APP_HANDLE_UNAVAILABLE', 'Open or find the expected App instance first.');
}
function turn(params: RecordValue) {
    const id = text(params, 'turn');
    if (active?.id !== id || !active.turn.isCurrent) error('TURN_NOT_ACTIVE', 'Use the currently adopted Desktop turn.');
    return active;
}
const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object') return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && 'value' in field ? field.value : undefined;
};
const clip = (value: string, limit: number): string => {
    if (value.length <= limit) return value;
    const end = value.charCodeAt(limit - 1);
    return value.slice(0, end >= 0xd800 && end <= 0xdbff ? limit - 1 : limit);
};
function issueFrom(cause: unknown): InteractionIssue {
    const verified = readRuntimeProtocolIssue(cause);
    if (verified) return { ...verified, code: verified.code === 'APP_AUTHORING_PROTOCOL_UNSUPPORTED' ? 'PROTOCOL_UNSUPPORTED' : verified.code };
    const code = own(cause, 'code'), message = own(cause, 'message');
    const path = own(cause, 'path') ?? own(own(cause, 'context'), 'path');
    if (typeof code === 'string' && code.length <= 128 && typeof message === 'string')
        return { code, message: clip(message, 2048), ...(typeof path === 'string' && path.length <= 512 ? { path } : {}) };
    return { code: 'REQUEST_FAILED', message: 'The Runtime could not complete this request.' };
}

/** Only project own fields captured by the original Runtime install failure. */
function openAppIssue(cause: unknown): InteractionIssue {
    const plain = issueFrom(cause);
    if (own(cause, 'code') !== 'INSTALL_FAILED') return plain;
    const original = own(cause, 'cause');
    const phase = own(original, 'phase');
    const diagnostic = own(original, 'cause');
    const raw = (phase === 'INIT' || phase === 'OPEN') && own(diagnostic, 'phase') === phase ? diagnostic : original;
    const msg = own(raw, 'message');
    const code = own(raw, 'code'), path = own(raw, 'path');
    const startup = typeof msg !== 'string' ? undefined : {
        ...(phase === 'INIT' || phase === 'OPEN' ? { phase } : {}),
        ...(typeof code === 'string' && code.length <= 128 ? { code } : {}),
        message: clip(msg, 2048),
        ...(typeof path === 'string' && path.length <= 512 ? { path } : {}),
        ...(own(raw, 'truncated') === true || msg.length > 2048 || typeof path === 'string' && path.length > 512 ||
            typeof code === 'string' && code.length > 128 ? { truncated: true as const } : {}),
    };
    const report = own(cause, 'closeReport');
    const state = own(report, 'state'), worker = own(report, 'worker');
    const resourcesReleased = own(report, 'resourcesReleased'), hasFailures = own(report, 'hasFailures');
    const cleanup = own(report, 'appCleanupReport');
    const cleanupState = own(cleanup, 'state'), cleanupCodes = own(cleanup, 'issues');
    const appCleanupReport = (cleanupState === 'active' || cleanupState === 'stopped' || cleanupState === 'pending' ||
        cleanupState === 'completed' || cleanupState === 'failed') && own(cleanup, 'instanceId') === own(report, 'instanceId') &&
        own(cleanup, 'protocol') === 'app-lifecycle-v3' && Array.isArray(cleanupCodes) && cleanupCodes.length <= 3 &&
        cleanupCodes.every(code => code === 'APP_STOP_FAILED' || code === 'APP_STOP_ASYNC' || code === 'APP_CLEANUP_FAILED')
        ? { state: cleanupState, issues: [...cleanupCodes] } : undefined;
    const closeReport = own(report, 'scope') === 'app' && (state === 'closing' || state === 'settled') &&
        (worker === 'not-created' || worker === 'owned' || worker === 'retiring' || worker === 'exited') &&
        typeof resourcesReleased === 'boolean' && typeof hasFailures === 'boolean'
        ? { state, worker, resourcesReleased, hasFailures, ...(appCleanupReport ? { appCleanupReport } : {}) } : undefined;
    const cleanupError = own(cause, 'cleanupError');
    const cleanupIssue = cleanupError === undefined ? undefined : issueFrom(cleanupError);
    const extension = { ...(startup ? { startup } : {}), ...(closeReport ? { closeReport } : {}), ...(cleanupIssue ? { cleanupIssue } : {}) };
    const bytes = () => utf8Size(canonicalJson(extension as import('@aotui/core').JsonValue));
    // The known cleanup/release facts and exact paths outrank optional text.
    while (bytes() > 16 * 1024) {
        if (startup && startup.message.length > 128) {
            startup.message = clip(startup.message, Math.max(128, Math.floor(startup.message.length / 2)));
            Object.assign(startup, { truncated: true });
        } else if (cleanupIssue && cleanupIssue.message.length > 128) {
            Object.assign(cleanupIssue, { message: clip(cleanupIssue.message, Math.max(128, Math.floor(cleanupIssue.message.length / 2))) });
        } else if (cleanupIssue && extension.cleanupIssue) delete extension.cleanupIssue;
        else if (startup && Object.hasOwn(startup, 'path')) {
            delete startup.path; Object.assign(startup, { truncated: true });
        } else break;
    }
    if (bytes() > 16 * 1024) throw new Error('Bounded startup extension exceeds its invariant');
    return { ...plain, ...extension };
}

function opened(app: RunningApp) {
    if (closing) error('CONNECTION_CLOSING', 'This Runtime connection is closing.');
    apps.set(app.instanceId, app);
    return { app: app.instanceId, appId: app.appId, instanceId: app.instanceId };
}
function replaceTurn(next?: typeof active) {
    for (const id of active?.observations ?? []) if (!next?.observations.has(id)) candidates.delete(id);
    active = next;
}

function scopeFor(id: string) {
    return scopes.get(id) ?? error('CANDIDATE_SCOPE_CLOSED', 'Begin a candidate scope on this connection.');
}

function discardScope(id: string) {
    const batch = scopes.get(id);
    if (!batch) return [];
    scopes.delete(id);
    const issues = batch.scope.discard();
    for (const candidate of batch.observed) if (!active?.observations.has(candidate)) candidates.delete(candidate);
    return issues;
}

function strings(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry.length))
        error('INVALID_REQUEST', `Provide ${label} as an array of non-empty strings.`);
    return value;
}

function initialize(params: RecordValue) {
    if (capabilities) error('ALREADY_INITIALIZED', 'The protocol was already initialized.');
    if (params.protocol !== protocol || params.majorVersion !== majorVersion)
        error('PROTOCOL_UNSUPPORTED', `Requested ${JSON.stringify(params.protocol)} major ${JSON.stringify(params.majorVersion)}. Supported: ${protocol} major ${majorVersion}.`,
            params.protocol === protocol ? '$.majorVersion' : '$.protocol');
    const requested = params.capabilities === undefined ? {} : record(params.capabilities, 'capabilities');
    const required = requested.required === undefined ? [] : strings(requested.required, 'required capabilities');
    const optional = requested.optional === undefined ? [] : strings(requested.optional, 'optional capabilities');
    const missing = [...new Set(required.filter(name => !supportedCapabilities.includes(name)))];
    if (missing.length) error('PROTOCOL_UNSUPPORTED', 'Required Host capabilities are unavailable: ' + missing.join(', ') + '.', '$.capabilities.required');
    capabilities = new Set(supportedCapabilities.filter(name => required.includes(name) || optional.includes(name)));
    if (capabilities.has(outputEvents)) desktop.output.subscribe(forwardOutput);
    return { protocol, majorVersion, capabilities: [...capabilities] };
}

function subscribeOutput(params: RecordValue) {
    if (!capabilities?.has(outputEvents)) error('PROTOCOL_UNSUPPORTED', 'Negotiate output-events before subscribing to App updates.');
    const directory = desktop.listApps();
    const instances = strings(params.apps, 'apps').map(handle => {
        const original = directory.find(entry => entry.appInstanceId === handle);
        if (!original?.appId || !original.appInstanceId)
            error('APP_HANDLE_UNAVAILABLE', 'Subscribe to an owned App instance.');
        return [original.appInstanceId, original.appId] as const;
    });
    subscribed.clear();
    for (const [instanceId, appId] of instances) subscribed.set(instanceId, appId);
    return null;
}

async function registerApp(params: RecordValue) {
    if (params.backend !== undefined) error('INVALID_REQUEST', 'Register a localPath or a negotiated command.');
    const toolsEnabled = params.toolsEnabled;
    if (toolsEnabled !== undefined && typeof toolsEnabled !== 'boolean') error('INVALID_REQUEST', 'Provide toolsEnabled as a boolean.');
    const options = {
        installationId: text(params, 'installationId'),
        ...(params.config === undefined ? {} : { config: record(params.config, 'config') }),
        ...(params.projectionLimits === undefined ? {} : { projectionLimits: record(params.projectionLimits, 'projectionLimits') as ProjectionLimitOverrides }),
        ...(params.interactionLimits === undefined ? {} : { interactionLimits: params.interactionLimits as InteractionLimitOverrides }),
        ...(toolsEnabled === undefined ? {} : { toolsEnabled }),
    };
    if (params.command === undefined)
        return { installationId: await desktop.registerPendingApp({ ...options, localPath: text(params, 'localPath') }) };
    if (!capabilities?.has(commandApps)) error('PROTOCOL_UNSUPPORTED', 'Negotiate command-apps before registering a command application.');
    if (params.localPath !== undefined) error('INVALID_REQUEST', 'Provide either localPath or command to register an App.');
    const command = params.command;
    if (!Array.isArray(command) || !command[0] || command.some(value => typeof value !== 'string'))
        error('INVALID_REQUEST', 'Provide a command as an executable and a list of string arguments.');
    const metadata = Object.fromEntries(['description', 'whatItIs', 'whenToUse']
        .filter(key => params[key] !== undefined).map(key => [key, text(params, key)]));
    return { installationId: await desktop.registerPendingApp({ ...options, ...metadata, name: text(params, 'name'), command }) };
}

function forwardOutput(signal: UpdateSignal) {
    if (closing || subscribed.get(signal.instanceId) !== signal.appId) return;
    void sendFrame({ event: 'output', signal });
    if (!desktop.listApps().some(entry => entry.appId === signal.appId && entry.appInstanceId === signal.instanceId)) {
        subscribed.delete(signal.instanceId);
        apps.delete(signal.instanceId);
    }
}

function reportCleanup(issues: readonly InteractionIssue[]) {
    if (!issues.length) return;
    console.error('Candidate cleanup failed', issues);
    process.exitCode = 1;
}

function beginClose() {
    if (!closing) {
        closing = true;
        desktop.output.unsubscribe(forwardOutput);
        subscribed.clear();
        for (const id of scopes.keys()) reportCleanup(discardScope(id));
        if (active) reportCleanup(active.turn.release());
        replaceTurn();
        for (const candidate of candidates.values()) reportCleanup(candidate.discard());
        candidates.clear();
    }
    return runtime.beginClose();
}

// The Host supplies its filtered catalog and layout. Observations and mounts come from this Desktop.
function present(params: RecordValue, batch: StdioScope) {
    if (!Array.isArray(params.apps) || !Array.isArray(params.catalog) || !Array.isArray(params.capabilities))
        error('INVALID_REQUEST', 'Provide apps, catalog installation IDs and capabilities as arrays.');
    const capabilities = params.capabilities.map(value => {
        if (typeof value !== 'string' || !Object.hasOwn(DESKTOP_TOOL_NAMES, value)) error('INVALID_REQUEST', 'Unknown Desktop capability.');
        return value as DesktopCapability;
    });
    const installed = desktop.listApps();
    const selected = params.apps.map((value: unknown) => {
        const item = record(value, 'an App layout');
        const id = text(item, 'candidate');
        const candidate = batch.observed.has(id) && candidates.get(id);
        if (!candidate) error('CANDIDATE_UNAVAILABLE', 'Prepare a candidate in this scope first.');
        const { observation } = candidate;
        const windows = new Map<string, ViewPresentation>();
        const closeMounts = item.closeMounts === undefined ? undefined : new Set(strings(item.closeMounts, 'closeMounts'));
        if (closeMounts && (closeMounts.size !== (item.closeMounts as readonly unknown[]).length ||
            [...closeMounts].some(id => !observation.views.some(view => view.viewInstanceId === id && view.canClose))))
            error('OBSERVATION_WINDOW_CHANGED', 'Choose each originally closable mount once.');
        if (!Array.isArray(item.views)) error('INVALID_REQUEST', 'Provide a views layout array.');
        for (const value of item.views) {
            const layout = record(value, 'a View layout');
            const id = text(layout, 'viewInstanceId');
            if (windows.has(id) || !observation.views.some(view => view.viewInstanceId === id))
                error('OBSERVATION_WINDOW_CHANGED', 'Choose each View mount once from the original observation.');
            switch (layout.kind) {
                case 'body': case 'omitted': windows.set(id, { kind: layout.kind }); break;
                case 'hint': windows.set(id, { kind: 'hint', ...(typeof layout.text === 'string' ? { text: layout.text } : {}) }); break;
                case 'collapsed': windows.set(id, { kind: 'collapsed', ...(typeof layout.note === 'string' ? { note: layout.note } : {}) }); break;
                default: error('INVALID_REQUEST', 'Choose body, hint, collapsed or omitted.');
            }
        }
        return { observation, windows, closeMounts, collapsed: item.collapsed === true, note: typeof item.note === 'string' ? item.note : undefined };
    });
    const catalog = params.catalog.map(id => {
        const app = installed.find(app => app.installationId === id) ?? error('INVALID_REQUEST', 'Select an installed application.');
        const layout = selected.find(({ observation }) => observation.source.instanceId === app.appInstanceId);
        const live = app.appId && app.appInstanceId ? desktop.getAppWindows(app.appId, app.appInstanceId) : undefined;
        return { app, ...(layout?.note === undefined ? {} : { note: layout.note }), ...(live ? { windows: {
            ...live, expanded: !layout?.collapsed, views: live.views.map(view => ({
                ...view, expanded: layout?.windows.get(view.viewInstanceId)?.kind !== 'collapsed',
            })),
        } } : {}) };
    });
    return projectDesktop({ apps: selected, catalog, capabilities, compact: params.compact === true, strict: params.strict === true });
}

function timeout(params: RecordValue): number | undefined {
    const value = params.timeoutMs;
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 300000)
        error('INVOCATION_INVALID', 'timeoutMs must be an integer from 1 to 300000.');
    return value;
}

async function dispatch(method: string, params: RecordValue): Promise<unknown> {
    if (closing && method !== 'shutdown') error('CONNECTION_CLOSING', 'This Runtime connection is closing.');
    if (method === 'initialize') return initialize(params);
    if (!capabilities) error('PROTOCOL_UNSUPPORTED', `Initialize ${protocol} major ${majorVersion} before calling Runtime methods.`);
    switch (method) {
        case 'desktop': return { id: desktop.id };
        case 'listApps': return desktop.listApps();
        case 'subscribeOutput': return subscribeOutput(params);
        case 'registerApp': return registerApp(params);
        case 'openApp': {
            if (Object.keys(params).some(key => key !== 'installationId')) error('INVALID_REQUEST', 'Supply only installationId.');
            return opened(await desktop.openApp(text(params, 'installationId')));
        }
        case 'getRunningApp': {
            const result = desktop.getRunningApp(text(params, 'appId'), text(params, 'instanceId'));
            return result.status === 'ready' ? { status: 'ready', ...opened(result.app) } : result;
        }
        case 'preview': return app(params).preview();
        case 'beginCandidateScope': {
            const scopeId = 'scope-' + ++scopeSequence;
            scopes.set(scopeId, { scope: desktop.createCandidateScope(), observed: new Set() });
            return { scopeId };
        }
        case 'discardScope': return { cleanupIssues: discardScope(text(params, 'scopeId')) };
        case 'observe': {
            const scopeId = text(params, 'scopeId');
            const batch = scopeFor(scopeId);
            const running = app(params);
            if (Object.keys(params).some(key => !['app', 'scopeId', 'options'].includes(key)))
                error('OBSERVATION_INVALID', 'Unknown observation field.');
            const result = await batch.scope.observe(running, params.options as ObservationOptions | undefined);
            if (result.status === 'rejected') return result;
            const scopeClosed = scopes.get(scopeId) !== batch;
            if (closing || scopeClosed || desktop.getRunningApp(running.appId, running.instanceId).status !== 'ready') {
                reportCleanup(result.candidate.discard());
                return { status: 'rejected', issue: scopeClosed
                    ? { code: 'CANDIDATE_SCOPE_CLOSED', message: 'The observation candidate scope is closed.' }
                    : { code: 'APP_INTERACTION_UNAVAILABLE', message: 'The original App is closing or unavailable.' } };
            }
            const { observation } = result.candidate;
            batch.observed.add(observation.observationId);
            candidates.set(observation.observationId, result.candidate);
            return { status: 'prepared', candidate: observation.observationId, observation };
        }
        case 'presentTurn': {
            const batch = scopeFor(text(params, 'scopeId'));
            batch.presentation = undefined;
            const result = present(params, batch);
            if (result.status !== 'ready')
                return { status: result.status, exclusions: result.exclusions, issues: result.issues, systemIssues: result.systemIssues };
            const selection = result.appSelections.map(({ observationId, windows }) => ({
                candidate: candidates.get(observationId)!, windows,
            }));
            // Keep only the latest trial per scope; adoption uses exactly the measured mounts and tools.
            batch.presentation = { id: ++presentationSequence, apps: selection, tools: result.tools };
            return { status: 'ready', presentation: batch.presentation.id, closeRoutes: result.closeRoutes, views: result.views, desktop: result.desktop, instruction: result.instruction,
                apps: result.appSelections.map(({ observationId, windows }) => ({ candidate: observationId, windows })),
                tools: result.tools.map(({ name, description, inputSchema, route }) => ({
                    name, description, schema: inputSchema, ...(route && { toolId: route.toolId, observationId: route.observationId }),
                })), issues: result.issues, systemIssues: result.systemIssues, exclusions: result.exclusions };
        }
        case 'adoptTurn': {
            const trial = scopeFor(text(params, 'scopeId')).presentation;
            if (!trial || trial.id !== params.presentation)
                error('PRESENTATION_UNAVAILABLE', 'Present the final measured layout in this scope before adoption.');
            const selected = trial.apps;
            const result = desktop.adoptTurn({ apps: selected });
            if (result.status === 'rejected') return result;
            const id = 'turn-' + ++turnSequence;
            const observations = new Set(selected.map(({ candidate }) => candidate.observation.observationId));
            replaceTurn({ id, turn: result.turn, observations, tools: trial.tools });
            return { status: 'adopted', turn: id, cleanupIssues: result.cleanupIssues };
        }
        case 'invokeNative': {
            const current = turn(params);
            const routed = routeNativeInvocation(current.tools, text(params, 'name'), params.input, text(params, 'invocationId'));
            if (routed.status === 'rejected') return { kind: 'refused', ...routed.issue };
            const { appId, instanceId, ...invocation } = routed.invocation;
            if (candidates.get(invocation.observationId)?.observation.source.instanceId !== instanceId)
                error('CANDIDATE_UNAVAILABLE', 'Use an observation prepared by this App instance.');
            return current.turn.invoke(appId, invocation, timeout(params));
        }
        case 'inspectRef': {
            const { turn: _turn, ...input } = params;
            const checked = captureSystemInput({ inputSchema: inspectRefSchema }, input);
            if (checked.status === 'rejected') error(checked.issue.code, checked.issue.message, checked.issue.path);
            return turn(params).turn.inspectRef(checked.value.address as string, checked.value.mode as 'schema' | 'value');
        }
        case 'readReceipt': return app(params).readReceipt({ observationId: text(params, 'observationId'), invocationId: text(params, 'invocationId') }, timeout(params));
        case 'readDesktopReceipt': return desktop.readReceipt({
            desktopId: text(params, 'desktopId') as typeof desktop.id,
            appId: text(params, 'appId') as RunningApp['appId'],
            instanceId: text(params, 'instanceId'), observationId: text(params, 'observationId'), invocationId: text(params, 'invocationId'),
        }, timeout(params));
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
            const channel = params.channel ?? 'body';
            if (channel !== 'body' && channel !== 'close' && channel !== 'all') error('INVALID_REQUEST','Invalid revoke channel.');
            desktop.revokeWindowAccess(current.turn, target, channel);
            return null;
        }
        case 'closeView': {
            const current = turn(params);
            const target = record(params.target, 'target');
            if (Object.keys(target).length !== 4) error('INVALID_REQUEST', 'Supply the original close target.');
            return desktop.closeView({ turn: current.turn, target: {
                appId: text(target, 'appId') as RunningApp['appId'], instanceId: text(target, 'instanceId'),
                viewId: text(target, 'viewId'), viewInstanceId: text(target, 'viewInstanceId'),
            }, invocationId: text(params, 'invocationId') }, { timeoutMs: timeout(params) });
        }
        case 'closeApp': {
            const fields = Object.keys(params);
            const handle = fields.length === 1 && Object.hasOwn(params, 'app');
            if (!handle && (fields.length !== 2 || !Object.hasOwn(params, 'appId') || !Object.hasOwn(params, 'instanceId')))
                error('INVALID_REQUEST', 'Supply either app, or appId and instanceId.');
            const target = handle ? app(params) : { appId: text(params, 'appId'), instanceId: text(params, 'instanceId') };
            const report = await desktop.beginCloseApp(target.appId, target.instanceId).completion;
            if (report.resourcesReleased) apps.delete(target.instanceId);
            for (const [id, candidate] of candidates) if (candidate.observation.source.instanceId === target.instanceId) candidates.delete(id);
            return report;
        }
        case 'shutdown': {
            const report = await beginClose().completion;
            if (report.resourcesReleased) stop();
            return report;
        }
        default: return error('METHOD_NOT_FOUND', 'Unknown Runtime stdio method.');
    }
}

function outputFailed(cause: unknown) {
    if (outputBroken) return;
    outputBroken = true;
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'EPIPE')) {
        console.error('Runtime protocol output failed', cause);
        process.exitCode = 1;
    }
    stop();
}

// Each call enqueues exactly one complete frame in stdout's ordered Writable.
function sendFrame(frame: unknown): Promise<void> {
    if (outputBroken) return lastWrite;
    const line = JSON.stringify(frame) + '\n';
    const written = new Promise<void>((resolve, reject) =>
        protocolWrite(line, cause => cause ? reject(cause) : resolve()));
    lastWrite = written.catch(outputFailed);
    return lastWrite;
}

async function respond(line: string) {
    let id: RequestId | null = null;
    let method: string | undefined;
    let payload: { result: unknown } | { error: InteractionIssue };
    try {
        // The Runtime enforces its App-specific budgets as well.
        if (Buffer.byteLength(line) > 1024 * 1024) error('INVALID_REQUEST', 'A request may use at most 1 MiB of JSON.');
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { error('INVALID_JSON', 'Supply one JSON request per line.'); }
        const request = record(parsed, 'request');
        if (typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) error('INVALID_REQUEST', 'Provide a string or integer request id.');
        const requestId = request.id as RequestId;
        if (requests.has(requestId)) error('REQUEST_ID_IN_USE', 'Provide a different id for each in-flight request.');
        id = requestId;
        requests.add(id);
        method = text(request, 'method');
        payload = { result: await dispatch(method, request.params === undefined ? {} : record(request.params, 'params')) };
    } catch (cause) { payload = { error: method === 'openApp' ? openAppIssue(cause) : issueFrom(cause) }; }
    try { await sendFrame({ id, ...payload }); }
    finally { if (id !== null) requests.delete(id); }
}

const inFlight = new Set<Promise<void>>();
try {
    for await (const line of lines) {
        if (inputStopped) break;
        const task = respond(line).catch(outputFailed);
        inFlight.add(task);
        void task.then(() => inFlight.delete(task));
    }
} finally {
    stop();
    const report = await beginClose().completion;
    await Promise.all(inFlight);
    await lastWrite;
    if (!report.ok || !report.resourcesReleased) {
        console.error('Runtime shutdown incomplete', report);
        process.exitCode = 1;
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.stdout.off('error', outputFailed);
}
