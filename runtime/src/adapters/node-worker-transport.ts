import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { APP_LIFECYCLE_PROTOCOL, normalizeProjectionLimits, checkWireJson } from '@aotui/core';
import { captureSnapshotDraftEnvelope, captureSnapshotPrepareIssue, captureViewTypes, TOOL_REQUEST_LIMITS } from '@aotui/core/producer';
import type { AcceptFrame, ExecutionConnection, ExecutionOptions, TransportEvents } from './execution-transport.js';
import type { AppExecutionRequest } from '../spi/runtime/execution-backend.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../spi/worker-protocol/index.js';
import { WORKER_PROTOCOL } from '../spi/worker-protocol/types.js';
import { captureAppCleanupReport, captureAppLifecycleAck } from './app-lifecycle-protocol.js';
import { captureToolInvocationTerminal } from './worker-message-capture.js';
import { initializationError, runtimeProtocolError, executionStartupError } from './initialization-error.js';

type KindOf = (id: string) => AppExecutionRequest['kind'] | undefined;
const failure = (code: string, path?: string) => Object.assign(new Error(code), { code, ...(path === undefined ? {} : { path }) });

/** Only this adapter knows the Node handshake and the private Worker messages. */
export function connectNodeWorker(worker: Worker, options: ExecutionOptions, emit: TransportEvents,
    accept: AcceptFrame, kindOf: KindOf, registeredName?: string): ExecutionConnection {
    const { appId, instanceId, projectionLimits, toolsEnabled } = options;
    const appLifecycle = { protocol: APP_LIFECYCLE_PROTOCOL, instanceId };
    let exited = false;
    // The Worker canonical declarations never change. Stage them only until the
    // Receiver's first successful accept, not until an acknowledgement arrives.
    let declarations: unknown;
    let sealed = false;
    const message = (msg: WorkerToMainMessage) => {
        if (exited || !msg || typeof msg !== 'object') return;
        const id = 'requestId' in msg && typeof msg.requestId === 'string' ? msg.requestId : undefined;
        const kind = id === undefined ? undefined : kindOf(id);
        if (msg.type === 'APP_EVENT') {
            if (msg.appId === appId && msg.instanceId === instanceId) emit({ kind: 'update', reason: msg.reason });
            return;
        }
        if (msg.type === 'SNAPSHOT_PREPARED') {
            const source = captureSnapshotDraftEnvelope(msg.draft);
            if (source?.appId === appId && source.instanceId === instanceId && Object.hasOwn(msg, 'viewTypes') &&
                !sealed && declarations === undefined) {
                try { declarations = captureViewTypes(msg.viewTypes, projectionLimits.metadata); }
                catch { /* Receiver reports the original declaration issue. */ }
            }
            const result = accept({ draft: msg.draft as import('@aotui/core').PreparedAppSnapshotDraft,
                ...(!sealed ? { viewTypes: Object.hasOwn(msg, 'viewTypes') ? msg.viewTypes : declarations } : Object.hasOwn(msg, 'viewTypes') ? { viewTypes: msg.viewTypes } : {}) },
            'authoritative', id);
            if (result.status === 'accepted') { sealed = true; declarations = undefined; }
            if (id !== undefined && kind === 'observe') {
                emit(result.status === 'accepted'
                    ? { kind: 'reply', id, status: 'done', publication: result.publication }
                    : { kind: 'reply', id, status: 'failed', issue: result.issue });
            }
            return;
        }
        if (msg.type === 'SNAPSHOT_PREPARE_FAILED') {
            if (msg.appId !== appId || msg.instanceId !== instanceId) return;
            const issue = captureSnapshotPrepareIssue(msg.error);
            emit({ kind: 'projectionFailed', ...(id === undefined ? {} : { id }),
                producerSeq: msg.producerSeq, sourceEpoch: msg.sourceEpoch, issue });
            if (id !== undefined && kind === 'observe') emit({ kind: 'reply', id, status: 'failed', issue });
            return;
        }
        if (id === undefined || kind === undefined) return;
        if (msg.type === 'PROJECTION_CURRENT') {
            const publication = captureSnapshotDraftEnvelope(msg);
            if (publication && Reflect.ownKeys(msg).length === 6)
                emit({ kind: 'projectionCurrent', id, publication });
            else if (kind === 'observe') emit({ kind: 'requestFailed', id, error: failure('OBSERVATION_REFRESH_FAILED') });
            return;
        }
        if (kind === 'invoke' || kind === 'closeView') {
            const terminal = captureToolInvocationTerminal(msg, { requestId: id, appId, instanceId });
            if (terminal) emit({ kind: 'reply', id, status: 'tool', terminal });
            return;
        }
        if (kind === 'initialize') {
            if (msg.type !== 'INIT_RESPONSE' && msg.type !== 'ERROR_RESPONSE' && msg.type !== 'LIFECYCLE_RESPONSE') return;
            if (msg.type === 'ERROR_RESPONSE' && msg.success === false) {
                const field = msg.protocolRejection;
                const code = field === 'factory.toolAuthoringProtocol' ? 'APP_AUTHORING_PROTOCOL_UNSUPPORTED'
                    : field === 'factory.appLifecycleSupport' ? 'APP_LIFECYCLE_UNSUPPORTED' : undefined;
                const error = code && (msg.error?.code === code || msg.error?.diagnostic?.code === code)
                    ? executionStartupError(runtimeProtocolError({ code, path: field!, message: msg.error.message }), appId, 'INIT')
                    : initializationError(msg.error, appId, 'INIT');
                emit({ kind: 'requestFailed', id, error });
                return;
            }
            try {
                if (msg.type !== 'INIT_RESPONSE' || msg.success !== true) throw failure('APP_INIT_ACK_INVALID');
                if (msg.protocol !== WORKER_PROTOCOL) throw failure('WORKER_PROTOCOL_UNSUPPORTED');
                if (!captureAppLifecycleAck(msg.appLifecycle, instanceId)) throw failure('APP_LIFECYCLE_NEGOTIATION_FAILED');
                if (msg.toolsEnabled !== toolsEnabled || msg.appInstanceId !== instanceId) throw failure('APP_INIT_ACK_INVALID');
                const path = 'INIT_RESPONSE.projectionLimits';
                try {
                    if (!isDeepStrictEqual(projectionLimits, normalizeProjectionLimits(msg.projectionLimits, path, true)))
                        throw new Error('Effective limits mismatch');
                } catch (error) { throw failure('APP_INIT_ACK_INVALID', (error as { path?: string })?.path ?? path); }
                emit({ kind: 'reply', id, status: 'ready' });
            } catch (error) { emit({ kind: 'requestFailed', id, error: error as Error }); }
            return;
        }
        if (msg.type !== 'LIFECYCLE_RESPONSE' && msg.type !== 'ERROR_RESPONSE') return;
        const cleanup = msg.type === 'LIFECYCLE_RESPONSE' ? captureAppCleanupReport(msg.appCleanup, instanceId) : null;
        if (msg.success !== true) {
            const error = kind === 'open' ? initializationError(msg.error, appId, 'OPEN')
                : failure(msg.error?.code ?? 'APP_CLOSE_FAILED');
            emit({ kind: 'requestFailed', id, error, ...(cleanup ? { cleanup } : {}) });
        } else if (msg.type === 'LIFECYCLE_RESPONSE') {
            emit({ kind: 'reply', id, status: 'done', ...(msg.publication ? { publication: msg.publication } : {}),
                ...(cleanup ? { cleanup: { state: cleanup.state, issues: cleanup.issues } } : {}) });
        }
    };
    const error = (error: Error) => { if (!exited) emit({ kind: 'error', error }); };
    const finish = (code?: number) => {
        if (exited) return;
        exited = true;
        worker.off('message', message);
        worker.off('error', error);
        worker.off('exit', finish);
        emit({ kind: 'channelEnded' });
        emit({ kind: 'exited', ...(code ? { issue: { code: 'WORKER_EXITED_UNEXPECTEDLY', message: 'The Worker exited with code ' + code } } : {}) });
    };
    worker.on('message', message);
    worker.on('error', error);
    worker.once('exit', finish);
    if (worker.threadId < 0) finish();
    function encode(request: AppExecutionRequest): MainToWorkerMessage {
        const requestId = request.id;
        switch (request.kind) {
            case 'initialize': return { type: 'INIT', requestId, appId, desktopId: options.desktopId,
                appModulePath: options.modulePath ?? '', ...(registeredName === undefined ? {} : { appName: registeredName }), appInstanceId: instanceId, appLifecycle,
                ...(options.config === undefined ? {} : { config: options.config }), projectionLimits, toolsEnabled, protocol: WORKER_PROTOCOL };
            case 'open': return { type: 'APP_OPEN', requestId };
            case 'stop': return { type: 'APP_STOP', requestId };
            case 'close': return { type: 'APP_CLOSE', requestId };
            case 'observe': return { type: 'FLUSH_PROJECTION', requestId, ...(request.known ? { known: request.known } : {}) };
            case 'closeView': return { type: 'VIEW_CLOSE', requestId, appId, instanceId, viewId: request.viewId,
                viewInstanceId: request.viewInstanceId, closeActivationId: request.closeActivationId };
            case 'invoke': return { type: 'VIEW_TOOL_INVOKE', requestId, appId, instanceId,
                tool: { ...request.tool, id: JSON.stringify([appId, request.tool.viewType, request.tool.name]) },
                receiver: request.receiver, effectiveArgs: request.input, localRefs: request.localRefs };
        }
    }
    return { transport: { send: request => {
        const message = encode(request);
        if (request.kind === 'invoke' || request.kind === 'closeView') {
            try { checkWireJson(message, TOOL_REQUEST_LIMITS); }
            catch {
                emit({ kind: 'reply', id: request.id, status: 'tool', terminal: { phase: 'not-entered', result: { success: false,
                    error: { code: 'REF_ARGUMENT_BUDGET_EXCEEDED', message: 'Complete Ref request exceeds the transport budget' } } } });
                return;
            }
        }
        worker.postMessage(message);
    } }, terminate: () => worker.terminate() };
}

export function startNodeWorker(options: ExecutionOptions, emit: TransportEvents, accept: AcceptFrame, kindOf: KindOf, registeredName?: string): ExecutionConnection {
    const filename = fileURLToPath(new URL('../worker-runtime/index.js', import.meta.url));
    return connectNodeWorker(new Worker(filename), options, emit, accept, kindOf, registeredName);
}
