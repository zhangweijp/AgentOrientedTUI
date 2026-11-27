import { APP_LIFECYCLE_PROTOCOL, type JsonValue, type SnapshotIssue } from '@aotui/core';
import { captureAppCleanupReport } from './app-lifecycle-protocol.js';
import { captureExecutionTerminal, invocationObject, text } from './worker-message-capture.js';
import type { TransportEvents } from './execution-transport.js';
import { runtimeProtocolError } from './initialization-error.js';
import type {
    AppExecutionEvent, AppExecutionIssue, AppExecutionLaunch, AppExecutionProjection, AppExecutionRequest,
} from '../spi/runtime/execution-backend.js';

const protocol = 'aotui-app';
const major = 2;
const supported: readonly string[] = ['attention'];
type Packet = Readonly<Record<string, JsonValue>>;

const invalid = (message: string, path: string): AppExecutionIssue => ({ code: 'APP_PROTOCOL_INVALID', message, path });
const names = (value: JsonValue | undefined): value is readonly string[] => Array.isArray(value) &&
    value.length <= 64 && value.every(item => text(item) && item.length <= 128) && new Set(value).size === value.length;

function readIssue(value: JsonValue | undefined): AppExecutionIssue | undefined {
    if (!invocationObject(value) || !text(value.code) || !text(value.message) || value.code.length > 128 || value.message.length > 4096) return;
    return { code: value.code, message: value.message, ...(text(value.path) && value.path.length <= 2048 ? { path: value.path } : {}) };
}

/** Translate the public JSON-Lines App protocol without exposing Worker messages or Core keys. */
export function externalAppProtocol(launch: AppExecutionLaunch, write: (packet: object) => void,
    emit: TransportEvents) {
    const pending = new Map<string, AppExecutionRequest['kind']>();
    let greeting: string | undefined;
    let capabilities: readonly string[] = [];
    let initializeAttempted = false;
    let startupSealed = false;
    let opened = false;
    let stopped = false;

    function fail(id: string, issue: AppExecutionIssue) {
        pending.delete(id);
        emit({ kind: 'reply', id, status: 'failed', issue });
    }

    function sealStartup(): 'not-dispatched' | 'cleanup-required' {
        startupSealed = true;
        if (!initializeAttempted) {
            if (greeting !== undefined) pending.delete(greeting);
            greeting = undefined;
            return 'not-dispatched';
        }
        return 'cleanup-required';
    }

    function send(request: AppExecutionRequest) {
        const { kind, id, ...details } = request;
        pending.set(id, kind);
        try {
            if (kind === 'initialize') {
                if (startupSealed) throw new Error('Startup is sealed');
                greeting = id;
                write({ type: 'hello', protocol, major, capabilities: supported, requires: [] });
            } else if (kind === 'invoke' || kind === 'closeView') {
                write({ type: kind, id, appId: launch.appId, instanceId: launch.instanceId, ...details });
            } else {
                if (kind === 'stop' || kind === 'close') stopped = true;
                write({ type: kind, id, ...details });
            }
        } catch (error) {
            // The write may have been accepted before it threw. Keep the id/kind.
            throw error;
        }
    }

    function negotiate(id: string, packet: Packet) {
        if (packet.type !== 'hello') {
            fail(id, invalid('The first App packet must be hello.', '$.type'));
            return;
        }
        if (packet.protocol !== protocol || packet.major !== major) {
            fail(id, runtimeProtocolError({ code: 'PROTOCOL_UNSUPPORTED', message: `This Runtime supports ${protocol} major ${major}. App offered ${
                text(packet.protocol) ? packet.protocol.slice(0, 128) : '<invalid identity>'} major ${
                typeof packet.major === 'number' ? packet.major : '<invalid version>'}.`,
                path: packet.protocol === protocol ? '$.major' : '$.protocol' }));
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
            fail(id, runtimeProtocolError({ code: 'CAPABILITY_REQUIRED', message: `App requires unsupported capability ${missing}.`, path: '$.requires' }));
            return;
        }
        capabilities = supported.filter(name => offered.includes(name));
        const { appId, instanceId, desktopId, name, config, toolsEnabled } = launch;
        if (startupSealed) return;
        // Even a thrown write does not prove the App did not acquire resources.
        initializeAttempted = true;
        try { write({ type: 'initialize', id, appId, instanceId, desktopId, name, ...(config === undefined ? {} : { config }), toolsEnabled, capabilities }); }
        catch (error) {
            emit({ kind: 'waitFailed', id, error: error instanceof Error ? error : new Error('Initialize delivery failed') });
        }
    }

    function publish(id: string, packet: Packet) {
        if (packet.mode !== 'authoritative' && packet.mode !== 'candidate') throw new Error('Invalid publication mode');
        // viewTypes is transported once alongside the complete raw frame.
        const frame = (invocationObject(packet.frame) && Object.hasOwn(packet, 'viewTypes')
            ? { ...packet.frame, viewTypes: packet.viewTypes } : packet.frame) as unknown as AppExecutionProjection;
        const sampled = text(packet.requestId) && ['open', 'observe'].includes(pending.get(packet.requestId) ?? '')
            ? packet.requestId : undefined;
        const result = launch.acceptProjection(frame, packet.mode, sampled);
        if (packet.mode === 'candidate' || result.status === 'rejected') write({ type: 'publishResult', id, ...result });
        if (opened && !stopped && result.status === 'accepted') emit({ kind: 'update', reason: 'view_updated' });
    }

    function reply(id: string, packet: Packet) {
        const request = pending.get(id);
        if (!request) return;
        if (request === 'invoke' || request === 'closeView') {
            if (packet.status !== 'tool') return;
            if (packet.appId !== launch.appId || packet.instanceId !== launch.instanceId) return;
            const terminal = captureExecutionTerminal(packet.terminal);
            if (terminal) {
                pending.delete(id);
                emit({ kind: 'reply', id, status: 'tool', terminal });
            }
            return;
        }
        if (packet.status === 'failed') {
            const issue = readIssue(packet.issue) ?? invalid('The App gave no valid issue for this reply.', '$.issue');
            const cleanup = invocationObject(packet.cleanup) && captureAppCleanupReport({ ...packet.cleanup,
                protocol: APP_LIFECYCLE_PROTOCOL, instanceId: launch.instanceId }, launch.instanceId);
            pending.delete(id);
            emit({ kind: 'reply', id, status: 'failed', issue,
                ...(cleanup ? { cleanup: { state: cleanup.state, issues: cleanup.issues } } : {}) });
            return;
        }
        if (request === 'initialize' && packet.status === 'ready') {
            pending.delete(id);
            emit({ kind: 'reply', id, status: 'ready' });
            return;
        }
        if (packet.status !== 'done' || request === 'initialize') return;
        if (request === 'open' || request === 'observe') {
            pending.delete(id);
            if (request === 'open') opened = true;
            emit({ kind: 'reply', id, status: 'done', publication: packet.publication as unknown as import('@aotui/core/host').SnapshotDraftEnvelope });
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
        } else if (value.type === 'hello' && startupSealed) {
            return;
        } else if (value.type === 'publish' && initializeAttempted && text(value.id)) {
            publish(value.id, value);
        } else if (value.type === 'projectionFailed' && initializeAttempted && !stopped) {
            const issue = readIssue(value.issue);
            if (!issue || !Number.isSafeInteger(value.producerSeq) || !Number.isSafeInteger(value.sourceEpoch)) throw new Error('Invalid fault publication');
            emit({ kind: 'projectionFailed', ...(text(value.requestId) && ['open', 'observe'].includes(pending.get(value.requestId) ?? '') ? { id: value.requestId } : {}), producerSeq: value.producerSeq as number, sourceEpoch: value.sourceEpoch as number, issue: issue as SnapshotIssue });
        } else if (value.type === 'projectionCurrent' && text(value.id)) {
            const kind = pending.get(value.id);
            if (kind === 'observe' || kind === 'open') {
                if (kind === 'observe') pending.delete(value.id);
                emit({ kind: 'projectionCurrent', id: value.id,
                    publication: value.publication as unknown as import('@aotui/core/host').SnapshotDraftEnvelope });
            }
        } else if (value.type === 'reply' && text(value.id)) {
            reply(value.id, value);
        } else if (value.type === 'attention' && opened && capabilities.includes('attention')) {
            emit({ kind: 'update', reason: 'attention_requested' });
        }
    }

    return { send, receive, sealStartup, get cleanupRequired() { return initializeAttempted; } };
}
