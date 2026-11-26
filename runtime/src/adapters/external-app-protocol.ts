import { APP_LIFECYCLE_PROTOCOL, type JsonValue, type SnapshotIssue } from '@aotui/core';
import { captureAppCleanupReport } from './app-lifecycle-protocol.js';
import { captureToolInvocationTerminal, invocationObject, text } from './worker-message-capture.js';
import type {
    AppExecutionEvent, AppExecutionIssue, AppExecutionLaunch, AppExecutionProjection, AppExecutionRequest,
} from '../spi/runtime/execution-backend.js';

const protocol = 'aotui-app';
const major = 1;
const supported: readonly string[] = ['attention'];
type Packet = Readonly<Record<string, JsonValue>>;

const invalid = (message: string, path: string): AppExecutionIssue => ({ code: 'APP_PROTOCOL_INVALID', message, path });
const invalidFrame = (message: string, path: string): SnapshotIssue => ({ code: 'SNAPSHOT_INVALID', message, path });
const names = (value: JsonValue | undefined): value is readonly string[] => Array.isArray(value) &&
    value.length <= 64 && value.every(item => text(item) && item.length <= 128) && new Set(value).size === value.length;

function readIssue(value: JsonValue | undefined): AppExecutionIssue | undefined {
    if (!invocationObject(value) || !text(value.code) || !text(value.message) || value.code.length > 128 || value.message.length > 4096) return;
    return { code: value.code, message: value.message, ...(text(value.path) && value.path.length <= 2048 ? { path: value.path } : {}) };
}

/** Translate the public JSON-Lines App protocol without exposing Worker messages or Core keys. */
export function externalAppProtocol(launch: AppExecutionLaunch, write: (packet: object) => void,
    emit: (event: AppExecutionEvent) => void) {
    const pending = new Map<string, AppExecutionRequest['kind']>();
    let greeting: string | undefined;
    let capabilities: readonly string[] = [];
    let initialized = false;
    let opened = false;
    let revision = 0;
    let latest: AppExecutionProjection | undefined;
    let fault: SnapshotIssue | undefined;

    function fail(id: string, issue: AppExecutionIssue) {
        pending.delete(id);
        emit({ kind: 'reply', id, status: 'failed', issue });
    }

    function send(request: AppExecutionRequest) {
        const { kind, id, ...details } = request;
        pending.set(id, kind);
        try {
            if (kind === 'initialize') {
                greeting = id;
                write({ type: 'hello', protocol, major, capabilities: supported, requires: [] });
            } else if (kind === 'invoke' || kind === 'closeView') {
                write({ type: kind, id, appId: launch.appId, instanceId: launch.instanceId, ...details });
            } else {
                write({ type: kind, id });
            }
        } catch (error) {
            pending.delete(id);
            throw error;
        }
    }

    function negotiate(id: string, packet: Packet) {
        if (packet.type !== 'hello') {
            fail(id, invalid('The first App packet must be hello.', '$.type'));
            return;
        }
        if (packet.protocol !== protocol || packet.major !== major) {
            fail(id, { code: 'PROTOCOL_UNSUPPORTED', message: `This Runtime supports ${protocol} major ${major}. App offered ${
                text(packet.protocol) ? packet.protocol.slice(0, 128) : '<invalid identity>'} major ${
                typeof packet.major === 'number' ? packet.major : '<invalid version>'}.`,
                path: packet.protocol === protocol ? '$.major' : '$.protocol' });
            return;
        }
        const offered = packet.capabilities === undefined ? [] : packet.capabilities;
        const required = packet.requires === undefined ? [] : packet.requires;
        if (!names(offered) || !names(required)) {
            fail(id, invalid('Expected a list of distinct capability names.', !names(offered) ? '$.capabilities' : '$.requires'));
            return;
        }
        const missing = required.find(name => !supported.includes(name));
        if (missing) {
            fail(id, { code: 'CAPABILITY_REQUIRED', message: `App requires unsupported capability ${missing}.`, path: '$.requires' });
            return;
        }
        capabilities = supported.filter(name => offered.includes(name));
        const { appId, instanceId, desktopId, name, config, toolsEnabled } = launch;
        write({ type: 'initialize', id, appId, instanceId, desktopId, name, config: config ?? {}, toolsEnabled, capabilities });
    }

    function prepare(frame: AppExecutionProjection): SnapshotIssue | undefined {
        if (![frame.views, frame.refs, frame.tools].every(entries => Array.isArray(entries) && entries.every(invocationObject)))
            return invalidFrame('Publish complete views, refs and tools arrays.', '$.frame');
        try { return launch.checkProjection(frame); }
        catch { return invalidFrame('The App projection is invalid.', '$.frame'); }
    }

    function publish(id: string, packet: Packet) {
        const body = invocationObject(packet.frame) ? packet.frame : {};
        const frame = { revision: revision + 1, views: body.views, refs: body.refs, tools: body.tools } as unknown as AppExecutionProjection;
        const issue = packet.opening !== undefined && typeof packet.opening !== 'boolean'
            ? invalidFrame('opening must be a boolean.', '$.opening') : prepare(frame);
        if (issue?.code === 'OBSERVATION_CAPACITY' && packet.opening === true && latest && !fault) {
            const mounted = new Set(latest.views.map(view => view.viewInstanceId));
            if (frame.views.some(view => !mounted.has(view.viewInstanceId))) {
                write({ type: 'publishResult', id, status: 'rejected', issue });
                return;
            }
        }
        revision = frame.revision;
        const recovered = !!fault && !issue;
        fault = issue;
        if (issue) {
            write({ type: 'publishResult', id, status: 'failed', issue });
            if (opened) emit({ kind: 'projectionFailed', revision, issue });
        } else {
            latest = frame;
            write({ type: 'publishResult', id, status: 'prepared' });
            if (opened) emit({ kind: 'update', reason: recovered ? 'projection_recovered' : 'view_updated' });
        }
    }

    function reply(id: string, packet: Packet) {
        const request = pending.get(id);
        if (!request) return;
        if (request === 'invoke' || request === 'closeView') {
            if (packet.status !== 'tool') return;
            const terminal = captureToolInvocationTerminal({ type: 'VIEW_TOOL_INVOKE_RESPONSE', requestId: id, success: true,
                appId: packet.appId, instanceId: packet.instanceId, terminal: packet.terminal },
                { requestId: id, appId: launch.appId, instanceId: launch.instanceId });
            if (terminal) {
                pending.delete(id);
                emit({ kind: 'reply', id, status: 'tool', terminal });
            }
            return;
        }
        if (packet.status === 'failed') {
            fail(id, readIssue(packet.issue) ?? invalid('The App gave no valid issue for this reply.', '$.issue'));
            return;
        }
        if (request === 'initialize' && packet.status === 'ready') {
            pending.delete(id);
            initialized = true;
            emit({ kind: 'reply', id, status: 'ready' });
            return;
        }
        if (packet.status !== 'done' || request === 'initialize') return;
        if (request === 'open' || request === 'observe') {
            const issue = fault ?? (!latest ? invalidFrame('The App has not published an initial projection.', '$.frame') : undefined);
            if (request === 'open' && issue) { fail(id, issue); return; }
            pending.delete(id);
            const correlation = request === 'observe' ? { id } : {};
            if (issue) emit({ kind: 'projectionFailed', ...correlation, revision, issue });
            else emit({ kind: 'projection', ...correlation, frame: latest! });
            if (request === 'open') {
                opened = true;
                emit({ kind: 'reply', id, status: 'done' });
            }
            return;
        }
        const cleanup = invocationObject(packet.cleanup) && captureAppCleanupReport({ ...packet.cleanup,
            protocol: APP_LIFECYCLE_PROTOCOL, instanceId: launch.instanceId }, launch.instanceId);
        const expected = request === 'stop' ? 'stopped' : 'completed';
        if (!cleanup || cleanup.state !== expected && cleanup.state !== 'failed') {
            fail(id, invalid(`The App must provide a cleanup report for ${request}.`, '$.cleanup'));
            return;
        }
        if (request === 'close') {
            opened = false;
            initialized = false;
        }
        pending.delete(id);
        emit({ kind: 'reply', id, status: 'done', cleanup: { state: cleanup.state, issues: cleanup.issues } });
    }

    function receive(value: unknown) {
        if (!invocationObject(value)) throw new Error('Expected an App protocol JSON object.');
        if (greeting !== undefined) {
            const id = greeting;
            greeting = undefined;
            negotiate(id, value);
        } else if (value.type === 'publish' && initialized && text(value.id)) {
            publish(value.id, value);
        } else if (value.type === 'reply' && text(value.id)) {
            reply(value.id, value);
        } else if (value.type === 'attention' && opened && capabilities.includes('attention')) {
            emit({ kind: 'update', reason: 'attention_requested' });
        }
    }

    return { send, receive };
}
