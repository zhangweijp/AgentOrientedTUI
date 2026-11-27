/**
 * Real LLM acceptance of the default Host backend (no Electron GUI).
 *
 * Run a copy in B's formally installed Host consumer (never workspace links).
 * AOTUI_TEST_CONFIG_DB=/absolute/authorized/chat.sqlite
 * AOTUI_TEST_CONSUMER_ROOT=/absolute/installed/consumer
 * AOTUI_ACCEPTANCE_IDE_PACKAGE=/absolute/installed/ide
 * pnpm exec tsx test/semantic-host-llm.e2e.ts /absolute/project/.tmp/task/facts.json
 * Optional: AOTUI_TEST_PROVIDER (default: deepseek), AOTUI_TEST_MODEL (explicit in-memory model override).
 *
 * The existing configuration database is read-only. Credentials stay in memory;
 * the normal Host conversation database, project and app data are temporary.
 * Uses the default Source, configured model and packaged IDE entrypoint.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { mock } from 'node:test';
import { modelViews } from './fixtures/model-views.js';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import type { ModelMessage } from 'ai';
import type { Session, GuiUpdateEvent, ModelUsageEvent } from '../src/types/session.js';
import type { Message } from '../src/types/messages.js';

const MAX_DURATION_MS = 300_000;
const MAX_MODEL_REQUESTS = 12;
const startedAt = Date.now();
const factsFile = process.argv[2] ? path.resolve(process.argv[2]) : undefined;

const A_INITIAL = 'AOTUI_B5_A_VALUE=42\n';
const A_EDITED = 'AOTUI_B5_A_VALUE=43\n';
const B_INITIAL = 'AOTUI_B5_B_VALUE=200\n';
type ToolLabel = 'multi_open_file' | 'edit_file' | 'close_file_detail' | 'multi_close_file' | 'close_view' | 'other';
type Page = { file: 'A' | 'B'; viewId: string; viewInstanceId: string; observationId: string; value: string };
type Adopted = { appId: string; observationId: string; views: ReadonlyArray<{ id: string; viewInstanceId: string }> };
interface RequestFacts {
    number: number;
    model: unknown;
    messages: unknown[];
    tools: unknown[];
    inputBytes: number;
    pages: Page[];
    openTool: boolean;
    editToolCount: number;
    editRequiresViewId: boolean;
    nonAppTool: boolean;
    httpStatus?: number;
    submitted: boolean;
}
interface ToolResultFacts {
    tool: ToolLabel;
    toolName: string;
    toolCallId: string;
    status: 'succeeded' | 'failed' | 'missing';
    internalMetadata: boolean;
    output: unknown;
}
interface AssistantFacts {
    requestNumber: number;
    hasMarker: boolean;
    textLength: number;
    hasToolCalls: boolean;
    content: unknown;
}
interface DispatchFact {
    requestNumber: number;
    requestId: string;
    instanceId: string;
    tool: string;
    target: unknown;
    input: unknown;
    observationId?: string;
    terminal?: unknown;
    diskAfter?: ReturnType<typeof disk>;
}
const facts = {
    passed: false,
    phase: 'setup',
    failureCode: undefined as string | undefined,
    elapsedMs: 0,
    provider: process.env.AOTUI_TEST_PROVIDER || 'deepseek',
    model: '',
    configuredModel: '',
    packageResolution: {} as Record<string, string>,
    idePackage: '',
    task: '',
    defaultSemanticSource: false,
    modelRequests: [] as RequestFacts[],
    toolResults: [] as ToolResultFacts[],
    assistantMessages: [] as AssistantFacts[],
    modelUsage: [] as ModelUsageEvent[],
    agentErrors: [] as { category: string; code: string }[],
    dispatches: [] as DispatchFact[],
    workerStarts: [] as {threadId: number; instanceId: string; protocol: string}[],
    workerExits: [] as {threadId: number; code: number}[],
    markerReceived: false,
    finalFiles: undefined as { A: string | null; B: string | null } | undefined,
    transitions: undefined as { initial: number; edited: number; closed: number; reopened: number } | undefined,
    configurationRowsInTestDatabase: -1,
    shutdown: undefined as import('@aotui/runtime').RuntimeCloseReport | undefined,
    moduleShutdown: undefined as import('@aotui/runtime').RuntimeCloseReport | undefined,
    cleanupErrors: [] as string[],
};
let credential: string | undefined;
let fileA = '', fileB = '';
let adopted: Adopted[] = [];
function capture<T>(value: T): T {
    const json = JSON.stringify(value);
    if (credential && json?.includes(credential)) {
        stopWithFailure('CREDENTIAL_REDACTED');
        throw new AcceptanceFailure('CREDENTIAL_REDACTED');
    }
    return json === undefined ? value : JSON.parse(json) as T;
}
function disk() {
    const read = (file: string) => {
        try { return readFileSync(file, 'utf8'); }
        catch (error) { if (object(error)?.code === 'ENOENT') return null; throw error; }
    };
    return { A: read(fileA), B: read(fileB) };
}
function progress(stage: string, detail: Record<string, string | number | boolean> = {}): void {
    process.stdout.write(JSON.stringify({ event: 'semantic-host-llm-progress', stage,
        elapsedMs: Date.now() - startedAt, ...detail }) + '\n');
}

class AcceptanceFailure extends Error {
    constructor(readonly code: string) { super(code); }
}
function requireFact(condition: unknown, code: string): asserts condition {
    if (!condition) throw new AcceptanceFailure(code);
}
function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}
function textContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.flatMap((part: unknown) => {
        const item = object(part);
        return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    }).join('\n');
}
function toolLabel(name: unknown): ToolLabel {
    if (typeof name !== 'string') return 'other';
    for (const expected of ['multi_open_file', 'edit_file', 'close_file_detail', 'multi_close_file', 'close_view'] as const) {
        if (name.includes(expected)) return expected;
    }
    return 'other';
}
function toolResultFacts(part: unknown): ToolResultFacts | undefined {
    const item = object(part);
    if (item?.type !== 'tool-result') return undefined;
    const output = object(item.output);
    const value = object(output?.value);
    const status = output?.type === 'json' ? 'succeeded' : output?.type === 'error-json' ? 'failed' : 'missing';
    const internalMetadata = value !== undefined && (Object.hasOwn(value, 'outcomeStatus') || Object.hasOwn(value, 'receipt')
        || object(value.result)?.receipt !== undefined);
    return { tool: toolLabel(item.toolName), toolName: String(item.toolName), toolCallId: String(item.toolCallId),
        status, internalMetadata, output: capture(item.output) };

}

/** Only one matching configuration is copied through a private child stdout pipe. */
function loadReadOnlyConfig(): LLMConfig {
    const configDb = process.env.AOTUI_TEST_CONFIG_DB;
    requireFact(configDb && path.isAbsolute(configDb), 'CONFIG_DB_ABSOLUTE_PATH_REQUIRED');
    requireFact(/^[a-zA-Z0-9_.:-]+$/.test(facts.provider), 'INVALID_TEST_PROVIDER');
    requireFact(!factsFile || factsFile !== path.resolve(configDb), 'FACTS_PATH_IS_CONFIG_DATABASE');
    const python = String.raw`
import json, pathlib, sqlite3, sys
try:
    uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro'
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only = ON')
    row = connection.execute('''SELECT model, provider_id, base_url, api_key
        FROM llm_configs WHERE lower(provider_id) = lower(?)
          AND api_key IS NOT NULL AND length(trim(api_key)) > 0
        ORDER BY is_active DESC, updated_at DESC LIMIT 1''', (sys.argv[2],)).fetchone()
    connection.close()
    if row is None:
        sys.exit(3)
    sys.stdout.write(json.dumps(dict(row)))
except Exception:
    sys.exit(2)
`;
    let row: Record<string, unknown> | undefined;
    try {
        row = object(JSON.parse(execFileSync('python3', ['-c', python, configDb, facts.provider], {
            encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        })));
    } catch (error) {
        // execFile errors can contain child stdout; never propagate that object.
        throw new AcceptanceFailure(object(error)?.status === 3 ? 'NO_AUTHORIZED_PROVIDER_ROW' : 'CONFIG_READ_FAILED');
    }
    requireFact(row && typeof row.model === 'string' && row.model.length > 0
        && typeof row.provider_id === 'string' && typeof row.api_key === 'string'
        && row.api_key.length > 0, 'INVALID_PROVIDER_CONFIG');
    credential = row.api_key;
    facts.provider = row.provider_id;
    facts.configuredModel = row.model;
    const model = process.env.AOTUI_TEST_MODEL ?? row.model;
    requireFact(/^[a-zA-Z0-9_.:/-]+$/.test(model), 'INVALID_TEST_MODEL');
    facts.model = model;
    return {
        model,
        apiKey: row.api_key,
        provider: { id: row.provider_id, ...(typeof row.base_url === 'string' && row.base_url
            ? { baseURL: row.base_url } : {}) },
        temperature: 0,

        modelCapabilities: { toolCall: true },
    };
}

// Product loggers may print full provider errors. This dedicated test process
// emits only the allow-listed facts below, never a transcript or raw exception.
const silent = (..._values: unknown[]): void => {};
console.log = console.info = console.warn = console.error = console.debug = console.trace = silent;

let work: string | undefined;
let session: Session | undefined;
let manager: import('../src/core/session-manager-v3.js').SessionManagerV3 | undefined;
let runtime: ReturnType<typeof import('@aotui/runtime').createRuntime> | undefined;
let moduleRuntime: import('@aotui/runtime').IKernel | undefined;
let database: typeof import('../src/db/index.js') | undefined;
const networkAbort = new AbortController();
let finish: () => void = () => {};
const finished = new Promise<void>(resolve => { finish = resolve; });
function stopWithFailure(code: string): void {
    facts.failureCode ??= code;
    session?.agentDriver.stop();
    networkAbort.abort();
    finish();
}
// Host emits model-input errors directly (without MessageService persistence).
// Record only its stable classification; do not retain raw provider errors.
function recordAgentError(message: unknown): boolean {
    const metadata = object(object(message)?.metadata);
    if (metadata?.isAgentError !== true) return false;
    const category = typeof metadata.errorCategory === 'string' && ['model_input', 'provider', 'network', 'rate_limit', 'unknown'].includes(metadata.errorCategory)
        ? metadata.errorCategory : 'unknown';
    const code = typeof metadata.errorCode === 'string' && /^MODEL_[A-Z0-9_]+$/.test(metadata.errorCode)
        ? metadata.errorCode : 'AGENT_RUN_ERROR';
    facts.agentErrors.push({ category, code });
    stopWithFailure(code);
    return true;
}
const deadline = setTimeout(() => stopWithFailure('TIME_LIMIT'), MAX_DURATION_MS);
const originalFetch = globalThis.fetch;

// This is a transparent network audit, not a model stub. It also aborts the
// actual provider stream when the overall test deadline or request limit fires.
globalThis.fetch = async (input, init) => {
    networkAbort.signal.throwIfAborted();
    let request: RequestFacts | undefined;
    try { if (typeof init?.body === 'string') {
        let body: Record<string, unknown> | undefined;
        try { body = object(JSON.parse(init.body)); } catch { /* Non-JSON request. */ }
        if (Array.isArray(body?.messages)) {
            if (facts.modelRequests.length >= MAX_MODEL_REQUESTS) {
                stopWithFailure('MODEL_REQUEST_LIMIT');
                throw new AcceptanceFailure('MODEL_REQUEST_LIMIT');
            }
            const tools = Array.isArray(body.tools) ? body.tools : [];
            request = capture({
                number: facts.modelRequests.length + 1, model: body.model,
                messages: body.messages, tools, inputBytes: Buffer.byteLength(init.body),
                pages: [], openTool: false, editToolCount: 0, editRequiresViewId: false, nonAppTool: false, submitted: false,
            });
            facts.modelRequests.push(request);
            // Only the exact Source envelope is a projection; the history's
            // User task and tool receipts are not additional View instances.
            const views = modelViews(body.messages.flatMap((message: unknown) => {
                const item = object(message);
                return item?.role === 'user' ? [{ role: 'user', content: textContent(item.content) }] : [];
            })).filter(view => view.appId === 'system_ide' && view.type === 'FileDetail');
            const pages: Page[] = views.map(view => {
                const file = view.markup.includes('## ' + fileA + '\n') ? 'A'
                    : view.markup.includes('## ' + fileB + '\n') ? 'B' : undefined;
                const observation = adopted.find(app => app.appId === view.appId);
                const mount = observation?.views.find(item => item.id === view.id);
                requireFact(file && observation && mount, 'UNBOUND_MODEL_FILE_VIEW');
                const content = view.markup.split('### Content\n')[1] ?? '';
                const value = file === 'A' ? (content.includes(A_EDITED.trim()) ? A_EDITED : content.includes(A_INITIAL.trim()) ? A_INITIAL : '')
                    : content.includes(B_INITIAL.trim()) ? B_INITIAL : '';
                requireFact(value && !(file === 'A' && content.includes(A_INITIAL.trim()) && content.includes(A_EDITED.trim())), 'STALE_OR_MISSING_FILE_CONTENT');
                return { file, viewId: view.id, viewInstanceId: mount.viewInstanceId, observationId: observation.observationId, value };
            });
            requireFact(new Set(pages.map(page => page.file)).size === pages.length, 'DUPLICATE_FILE_PROJECTION');
            const definitions = tools.flatMap((tool: unknown) => {
                const definition = object(object(tool)?.function);
                return definition && typeof definition.name === 'string' ? [definition] : [];
            });
            const edits = definitions.filter(tool => toolLabel(tool.name) === 'edit_file');
            const parameters = object(edits[0]?.parameters);
            Object.assign(request, {
                pages, openTool: definitions.some(tool => toolLabel(tool.name) === 'multi_open_file'),
                editToolCount: edits.length,
                editRequiresViewId: edits.length === 1 && Array.isArray(parameters?.required) && parameters.required.includes('view_id'),
                nonAppTool: definitions.some(tool => typeof tool.name === 'string' && (tool.name.startsWith('mcp-') || tool.name === 'skill')),
            });
            progress('model-request', { number: request.number });
        } else if (body && (Array.isArray(body.input) || Array.isArray(body.contents))) {
            // This existing Runner is a Chat Messages consumer, not a second
            // Provider matrix. Never send an unaudited model request.
            stopWithFailure('MODEL_WIRE_NOT_SUPPORTED_BY_RUNNER');
            throw new AcceptanceFailure('MODEL_WIRE_NOT_SUPPORTED_BY_RUNNER');
        }
    } } catch (error) {
        stopWithFailure(error instanceof AcceptanceFailure ? error.code : 'MODEL_REQUEST_CAPTURE_FAILED');
        throw new AcceptanceFailure(facts.failureCode ?? 'MODEL_REQUEST_CAPTURE_FAILED');
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (request) request.submitted = true;
    const response = await originalFetch(input, { ...init,
        signal: signal ? AbortSignal.any([networkAbort.signal, signal]) : networkAbort.signal });
    if (request) request.httpStatus = response.status;
    return response;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function cleanupStep(label: string, cleanup: () => void | Promise<void>): Promise<void> {
    try { await cleanup(); } catch { facts.cleanupErrors.push(label); }
}

try {
    progress('setup');
    requireFact(factsFile, 'FACTS_OUTPUT_PATH_REQUIRED');
    const llmConfig = loadReadOnlyConfig();
    const consumer = process.env.AOTUI_TEST_CONSUMER_ROOT;
    const ide = process.env.AOTUI_ACCEPTANCE_IDE_PACKAGE;
    requireFact(consumer && path.isAbsolute(consumer) && ide && path.isAbsolute(ide), 'FORMAL_PACKAGE_HANDOFF_REQUIRED');
    const installed = await fs.realpath(path.join(consumer, 'node_modules'));
    for (const name of ['@aotui/core', '@aotui/sdk', '@aotui/runtime', '@aotui/agent-driver-v2', '@aotui/agent-driver-adapter']) {
        const resolved = await fs.realpath(fileURLToPath(import.meta.resolve(name)));
        requireFact(resolved.startsWith(installed + path.sep), 'FRAMEWORK_RESOLVED_OUTSIDE_FORMAL_CONSUMER');
        facts.packageResolution[name] = resolved;
    }
    facts.idePackage = await fs.realpath(ide);
    work = await fs.realpath(await fs.mkdtemp(path.join(path.dirname(factsFile), 'model-work-')));
    const projectPath = path.join(work, 'project');
    const home = path.join(work, 'home');
    await fs.mkdir(projectPath);
    await fs.mkdir(home);
    fileA = path.join(projectPath, 'A.txt');
    fileB = path.join(projectPath, 'B.txt');
    await fs.writeFile(fileA, A_INITIAL);
    await fs.writeFile(fileB, B_INITIAL);
    process.env.HOME = home;
    mock.method(os, 'homedir', () => home);
    delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
    process.env.DB_PATH = path.join(work, 'chat.sqlite');
    process.env.AOTUI_DATA_DIR = path.join(work, 'data');

    // Passive observation of the actual execution transport. The original
    // postMessage and all Runtime acceptance/dispatch behavior stay unchanged.
    const workers = new WeakMap<Worker, { threadId: number; instanceId: string }>();
    const post = Worker.prototype.postMessage;
    mock.method(Worker.prototype, 'postMessage', function (this: Worker, ...args: Parameters<typeof post>) {
        const message = args[0];
        if (message?.type === 'INIT' && message.appName === 'system_ide') {
            const owner = { threadId: this.threadId, instanceId: message.appInstanceId as string };
            workers.set(this, owner);
            facts.workerStarts.push({ ...owner, protocol: message.protocol });
            this.on('message', reply => {
                if (reply?.type !== 'VIEW_TOOL_INVOKE_RESPONSE') return;
                const call = facts.dispatches.find(call => call.requestId === reply.requestId && call.instanceId === reply.instanceId);
                if (call) {
                    try { call.terminal = capture(reply.terminal); call.diskAfter = disk(); }
                    catch { stopWithFailure('TERMINAL_CAPTURE_FAILED'); }
                }
            });
            this.once('exit', code => facts.workerExits.push({ threadId: owner.threadId, code }));
        }
        const owner = workers.get(this);
        if (owner && (message.type === 'VIEW_TOOL_INVOKE' || message.type === 'VIEW_CLOSE')) {
            const observationId = adopted.find(app => app.appId === message.appId)?.observationId;
            facts.dispatches.push(capture({
                requestNumber: facts.modelRequests.length, requestId: message.requestId, instanceId: owner.instanceId,
                tool: message.type === 'VIEW_CLOSE' ? 'close_view' : message.tool.name,
                target: message.type === 'VIEW_CLOSE' ? { viewId: message.viewId, viewInstanceId: message.viewInstanceId } : message.receiver,
                input: message.type === 'VIEW_CLOSE' ? {} : message.effectiveArgs,
                observationId,
            }));
        }
        return post.apply(this, args);
    });

    const { createRuntime } = await import('@aotui/runtime');
    const { AppCatalog } = await import('../src/app-distribution/app-catalog.js');
    const { SemanticAOTUIDrivenSource } = await import('@aotui/agent-driver-adapter');
    const { AgentDriverV2 } = await import('@aotui/agent-driver-v2');
    const { DesktopManager, desktopManager: moduleDesktopManager } = await import('../src/core/desktop-manager.js');
    moduleRuntime = moduleDesktopManager.getKernel();
    const { SessionManagerV3 } = await import('../src/core/session-manager-v3.js');
    const { MessageService } = await import('../src/core/message-service.js');
    const { LLMConfigService } = await import('../src/core/llm-config-service.js');
    const { ModelRegistry } = await import('../src/services/model-registry.js');
    const { projectService } = await import('../src/core/project-service.js');
    database = await import('../src/db/index.js');
    await database.initDatabase();

    class InMemoryLLMConfigService extends LLMConfigService {
        override async resolveLLMConfig(): Promise<LLMConfig> { return llmConfig; }
    }
    class PrivateTestMessageService extends MessageService {
        override addMessage(topicId: string, message: ModelMessage): Message {
            // Session's normal error path attaches raw provider errors. Keep the
            // real persistence service, but never persist those details in a test.
            if (recordAgentError(message)) {
                return super.addMessage(topicId, { role: 'assistant', content: 'SEMANTIC_TEST_AGENT_ERROR' });
            }
            if (llmConfig.apiKey && JSON.stringify(message).includes(llmConfig.apiKey)) {
                stopWithFailure('CREDENTIAL_REDACTED');
                return super.addMessage(topicId, { role: 'assistant', content: 'SEMANTIC_TEST_REDACTED' });
            }
            return super.addMessage(topicId, message);
        }
    }

    runtime = createRuntime();
    const desktopManager = new DesktopManager({ kernel: runtime,
        appCatalog: new AppCatalog({ configPath: path.join(work, 'apps.json') }) });
    await desktopManager.initialize({ appEntries: [{
        name: 'system_ide', source: `local:${facts.idePackage}`,
        enabled: true, autoStart: true,
    }] });
    const project = projectService.createProject(projectPath, 'Semantic Host LLM fixture');
    const topicId = 'semantic-host-llm-e2e';
    database.createTopic({ id: topicId, title: 'Semantic Host LLM acceptance', status: 'hot',
        createdAt: Date.now(), updatedAt: Date.now(), projectId: project.id,
        sourceControls: {
            apps: { enabled: true, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [] },
            skill: { enabled: false, disabledItems: [] },
        },
        contextCompaction: { enabled: false },
    });
    manager = new SessionManagerV3(desktopManager,
        new InMemoryLLMConfigService(new ModelRegistry()), new PrivateTestMessageService(),
        { maxSessions: 1, idleTimeoutMs: MAX_DURATION_MS * 2, cleanupIntervalMs: MAX_DURATION_MS * 2 });
    manager.on('model-usage', (event: ModelUsageEvent) => {
        if (event.sessionId === topicId) facts.modelUsage.push(capture(event));
    });
    manager.on('message', (event: GuiUpdateEvent) => {
        if (event.topicId !== topicId || !event.message) return;
        if (recordAgentError(event.message)) return;
        if (event.type === 'tool' && Array.isArray(event.message.content)) {
            for (const part of event.message.content) {
                const fact = toolResultFacts(part);
                if (fact) {
                    facts.toolResults.push(fact);
                    progress('tool-result', { tool: fact.tool, status: fact.status });
                }
            }
        }
        if (event.type === 'assistant') {
            const text = textContent(event.message.content);
            const hasMarker = text.trim() === 'SEMANTIC_OK A=43 B=200';
            const hasToolCalls = Array.isArray(event.message.content)
                && event.message.content.some(part => object(part)?.type === 'tool-call');
            const assistantFact = { requestNumber: facts.modelRequests.length, hasMarker, textLength: text.length, hasToolCalls, content: capture(event.message.content) };
            facts.assistantMessages.push(assistantFact);
            progress('assistant-message', { hasMarker, textLength: text.length, hasToolCalls });
            if (hasMarker && !hasToolCalls) {
                facts.markerReceived = true;
                session?.agentDriver.stop();
                finish();
            }
        }
    });
    facts.phase = 'session';
    progress('session');
    session = await manager.ensureSession(topicId);
    manager.pauseSession(topicId);
    const adopt = session.desktop.adoptTurn.bind(session.desktop);
    mock.method(session.desktop, 'adoptTurn', (selection: Parameters<typeof adopt>[0]) => {
        const result = adopt(selection);
        if (result.status === 'adopted') adopted = selection.apps.map(({ candidate: { observation } }) => ({
            appId: observation.source.appId, observationId: observation.observationId,
            views: observation.views.map(({ id, viewInstanceId }) => ({ id, viewInstanceId })),
        }));
        return result;
    });
    requireFact(session.agentDriver instanceof AgentDriverV2, 'DEFAULT_AGENT_DRIVER_MISSING');
    facts.defaultSemanticSource = session.sources.aotui instanceof SemanticAOTUIDrivenSource;
    requireFact(facts.defaultSemanticSource, 'DEFAULT_SEMANTIC_SOURCE_MISSING');
    requireFact(session.desktop.listApps().length === 1, 'DEFAULT_IDE_INSTALLATION_FAILED');

    // Readiness only; the script never invokes app tools on the model's behalf.
    const readyDeadline = Date.now() + 20_000;
    while (true) {
        networkAbort.signal.throwIfAborted();
        const context = await session.sources.aotui.getContext();
        try {
            if (Object.keys(context.tools).some(name => name.includes('multi_open_file'))) {
                requireFact(!Object.keys(context.tools).some(name => name.includes('edit_file')), 'EDIT_EXPOSED_BEFORE_OPEN');
                break;
            }
        } finally { await context.release?.(); }
        requireFact(Date.now() < readyDeadline, 'IDE_READY_TIMEOUT');
        await sleep(50);
    }
    facts.phase = 'llm';
    progress('ready');
    facts.task = [
        'Complete this small acceptance task using only the installed AOTUI IDE native Tools and current Views.',
        `Open both existing files ${fileA} and ${fileB}. Read their current values from the FileDetail Views.`,
        'Change only A.txt from 42 to 43 using its own edit_file Tool. Preserve the rest of A and all of B.',
        'Read the refreshed FileDetail Views for both files before making another change; confirm B still contains 200.',
        'Close only A.txt (not the whole IDE and not B). Read the updated Views and confirm A is closed and B remains open.',
        'Reopen A.txt, read its current contents and confirm B remains unchanged.',
        'The Tool receipt is not the file contents. Use the current View and current view_id, never a stale target.',
        'Finish with exactly: SEMANTIC_OK A=43 B=200',
        'Do not use shell, MCP, skills, run_code, context compaction, or additional apps. Keep the task short.',
    ].join('\n');
    await manager.sendMessage(topicId, facts.task);
    manager.resumeSession(topicId);
    await finished;
    requireFact(!facts.failureCode, facts.failureCode || 'AGENT_RUN_FAILED');

    facts.phase = 'verification';
    progress('verification');
    facts.finalFiles = disk();
    requireFact(facts.finalFiles.A === A_EDITED && facts.finalFiles.B === B_INITIAL && facts.markerReceived, 'FINAL_FILES_OR_ANSWER_INCORRECT');
    requireFact(facts.modelRequests.length > 0 && facts.modelRequests.some(request => request.httpStatus === 200), 'NO_REAL_MODEL_REQUEST');
    requireFact(facts.workerStarts.length === 1 && facts.workerStarts[0]?.protocol === 'app-worker/v12', 'ACTUAL_IDE_WORKER_NOT_OBSERVED');
    const first = facts.modelRequests[0]!;
    requireFact(first.openTool && first.editToolCount === 0 && first.pages.length === 0, 'INITIAL_TOOL_SURFACE_INCORRECT');
    const page = (request: RequestFacts, file: Page['file']) => request.pages.find(page => page.file === file);
    const both = (request: RequestFacts, value: string) => page(request, 'A')?.value === value && page(request, 'B')?.value === B_INITIAL &&
        request.editToolCount === 1 && request.editRequiresViewId;
    const initial = facts.modelRequests.find(request => both(request, A_INITIAL));
    requireFact(initial, 'MODEL_DID_NOT_RECEIVE_BOTH_OPENED_VIEWS');
    const edited = facts.modelRequests.find(request => request.number > initial.number && both(request, A_EDITED));
    requireFact(edited, 'MODEL_DID_NOT_RECEIVE_LATEST_EDITED_VIEW');
    const closed = facts.modelRequests.find(request => request.number > edited.number && !page(request, 'A') &&
        page(request, 'B')?.value === B_INITIAL && request.editToolCount === 1 && request.editRequiresViewId);
    requireFact(closed, 'MODEL_DID_NOT_OBSERVE_ONLY_A_CLOSED');
    const reopened = facts.modelRequests.find(request => request.number > closed.number && both(request, A_EDITED));
    requireFact(reopened, 'MODEL_DID_NOT_OBSERVE_REOPENED_A');
    facts.transitions = { initial: initial.number, edited: edited.number, closed: closed.number, reopened: reopened.number };
    const originalA = page(initial, 'A')!, originalB = page(initial, 'B')!;
    requireFact(originalA.viewId === page(edited, 'A')!.viewId && originalA.viewInstanceId === page(edited, 'A')!.viewInstanceId,
        'A_CONTINUOUS_MOUNT_CHANGED');
    requireFact(page(reopened, 'A')!.viewInstanceId !== originalA.viewInstanceId, 'A_REOPEN_REUSED_MOUNT');
    for (const request of facts.modelRequests.filter(request => request.number >= initial.number)) {
        requireFact(page(request, 'B')?.viewId === originalB.viewId && page(request, 'B')?.viewInstanceId === originalB.viewInstanceId &&
            page(request, 'B')?.value === B_INITIAL, 'B_CONTINUOUS_VIEW_CHANGED');
        requireFact(request.editToolCount === 1 && request.editRequiresViewId, 'SHARED_FILE_TOOL_DECLARATION_INCORRECT');
    }
    requireFact(!facts.modelRequests.some(request => request.nonAppTool), 'DISABLED_SOURCE_TOOLS_EXPOSED');
    const writes = facts.dispatches.filter(call => ['edit_file', 'write_file', 'batch_edit', 'delete_file', 'create_file', 'rename_file'].includes(call.tool));
    requireFact(writes.length === 1 && writes[0]?.tool === 'edit_file' &&
        object(writes[0].target)?.viewId === originalA.viewId && object(writes[0].target)?.viewInstanceId === originalA.viewInstanceId &&
        writes[0].observationId === facts.modelRequests[writes[0].requestNumber - 1]?.pages.find(page => page.file === 'A')?.observationId &&
        writes[0].requestNumber >= initial.number && writes[0].requestNumber < edited.number &&
        writes[0].diskAfter?.A === A_EDITED && writes[0].diskAfter?.B === B_INITIAL &&
        object(object(writes[0].terminal)?.result)?.success === true, 'ACTUAL_EDIT_TARGET_OR_RESULT_INCORRECT');
    const closesA = (call: DispatchFact) => call.tool === 'multi_close_file'
        ? Array.isArray(object(call.input)?.filePaths) && (object(call.input)?.filePaths as unknown[]).includes(fileA)
        : ['close_file_detail', 'close_view'].includes(call.tool) && object(call.target)?.viewInstanceId === originalA.viewInstanceId;
    requireFact(facts.dispatches.some(call => call.requestNumber >= edited.number && call.requestNumber < closed.number &&
        closesA(call) && object(object(call.terminal)?.result)?.success === true), 'NO_ACTUAL_CLOSE_A_DISPATCH');
    requireFact(facts.dispatches.some(call => call.tool === 'multi_open_file' && call.requestNumber >= closed.number &&
        call.requestNumber < reopened.number && Array.isArray(object(call.input)?.filePaths) &&
        (object(call.input)?.filePaths as unknown[]).includes(fileA) && object(object(call.terminal)?.result)?.success === true), 'NO_ACTUAL_REOPEN_A_DISPATCH');
    requireFact(facts.assistantMessages.some(message => message.requestNumber === writes[0]!.requestNumber &&
        Array.isArray(message.content) && message.content.some(part => {
            const call = object(part);
            return call?.type === 'tool-call' && call.toolName === 'system_ide-FileDetail-edit_file' &&
                object(call.input)?.view_id === originalA.viewId;
        })), 'MISSING_MODEL_EDIT_DECISION');
    requireFact(facts.dispatches.every(call => call.observationId && call.terminal && call.diskAfter?.B === B_INITIAL), 'MISSING_ACTUAL_TERMINAL_OR_OBSERVATION');
    requireFact(facts.toolResults.some(receipt => receipt.tool === 'edit_file' && receipt.status === 'succeeded' && !receipt.internalMetadata),
        'MISSING_SUCCESSFUL_EDIT_FILE');
    requireFact(facts.toolResults.some(receipt => receipt.tool === 'multi_open_file' && receipt.status === 'succeeded' && !receipt.internalMetadata),
        'MISSING_SUCCESSFUL_OPEN_FILE');
    requireFact(facts.toolResults.some(receipt => ['close_file_detail', 'multi_close_file', 'close_view'].includes(receipt.tool) &&
        receipt.status === 'succeeded' && !receipt.internalMetadata), 'MISSING_SUCCESSFUL_CLOSE');
    requireFact(!facts.toolResults.some(receipt => receipt.internalMetadata), 'INVALID_MODEL_TOOL_RESULT');
    const configRows = database.getDb().exec('SELECT COUNT(*) FROM llm_configs')[0]?.values[0]?.[0];
    requireFact(typeof configRows === 'number', 'TEST_DATABASE_UNAVAILABLE');
    facts.configurationRowsInTestDatabase = configRows;
    requireFact(configRows === 0, 'CONFIGURATION_WAS_PERSISTED');
    facts.passed = true;
} catch (error: unknown) {
    facts.failureCode ??= error instanceof AcceptanceFailure ? error.code : 'HOST_ACCEPTANCE_FAILED';
} finally {
    progress('cleanup');
    clearTimeout(deadline);
    session?.agentDriver.stop();
    networkAbort.abort();
    // Let a cancelled model stream unwind before destroying its captured context.
    const idleDeadline = Date.now() + 3_000;
    while (session && session.agentDriver.getState() !== 'idle' && Date.now() < idleDeadline) await sleep(25);
    await cleanupStep('session', async () => { await manager?.cleanup(); });
    await cleanupStep('runtime', async () => {
        facts.shutdown = await runtime?.beginClose().completion;
        if (facts.shutdown) requireFact(facts.shutdown.ok && facts.shutdown.resourcesReleased && facts.shutdown.pendingTasks === 0 &&
            facts.shutdown.interactions?.retainedOperations === 0 && facts.shutdown.workers.report?.total === 0, 'RUNTIME_NOT_RELEASED');
    });
    await cleanupStep('module-runtime', async () => {
        facts.moduleShutdown = await moduleRuntime?.beginClose().completion;
        if (facts.moduleShutdown) requireFact(facts.moduleShutdown.ok && facts.moduleShutdown.resourcesReleased, 'MODULE_RUNTIME_NOT_RELEASED');
    });
    if (facts.workerStarts.some(start => !facts.workerExits.some(exit => exit.threadId === start.threadId)))
        facts.cleanupErrors.push('physical-worker-exit');
    mock.restoreAll();
    await cleanupStep('database', () => { database?.closeDatabase(); });
    // Preserve the actual final disk state even if the model or verification failed.
    if (fileA && fileB) await cleanupStep('final-files', () => { facts.finalFiles = capture(disk()); });
    await cleanupStep('temporary-files', async () => { if (work) await fs.rm(work, { recursive: true, force: true }); });
    facts.elapsedMs = Date.now() - startedAt;
    if (facts.cleanupErrors.length > 0) {
        facts.passed = false;
        facts.failureCode ??= 'CLEANUP_FAILED';
    }
    if (factsFile) {
        try {
            const serialized = JSON.stringify(facts, null, 2) + '\n';
            requireFact(!credential || !serialized.includes(credential), 'CREDENTIAL_REDACTED');
            await fs.writeFile(factsFile, serialized, { mode: 0o600, flag: 'wx' });
        }
        catch { facts.passed = false; facts.failureCode = 'FACTS_WRITE_FAILED'; }
    }
    // Keep the aborting fetch and muted product logger until this isolated
    // process exits, so late SDK retries cannot restart a call or log an error.
    process.stdout.write(JSON.stringify({ passed: facts.passed, failureCode: facts.failureCode,
        modelRequests: facts.modelRequests.length, toolResults: facts.toolResults.length, elapsedMs: facts.elapsedMs }) + '\n');
    process.exit(facts.passed ? 0 : 1);
}
