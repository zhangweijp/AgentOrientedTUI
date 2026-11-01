/**
 * Real LLM acceptance of the default Host backend (no Electron GUI).
 *
 * From host/: AOTUI_TEST_CONFIG_DB=/path/to/chat.sqlite pnpm exec tsx \
 *   test/semantic-host-llm.e2e.ts /tmp/semantic-host-llm-facts.json
 * Optional: AOTUI_TEST_PROVIDER (default: deepseek).
 *
 * The existing configuration database is read-only. Credentials stay in memory;
 * the normal Host conversation database, project and app data are temporary.
 * No test Source, fake model, special IDE entrypoint or Legacy fallback is used.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import type { ModelMessage } from 'ai';
import type { Session, GuiUpdateEvent } from '../src/types/session.js';
import type { Message } from '../src/types-v2.js';

const MAX_DURATION_MS = 300_000;
const MAX_MODEL_REQUESTS = 12;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const startedAt = Date.now();
const factsFile = process.argv[2] ? path.resolve(process.argv[2]) : undefined;

type ToolLabel = 'multi_open_file' | 'read_loaded_diagnostics' | 'edit_file' | 'other';
interface RequestFacts {
    number: number;
    file42Views: number;
    file43Views: number;
    openTool: boolean;
    diagnosticsTool: boolean;
    editTool: boolean;
    nonAppTool: boolean;
}
interface ToolResultFacts {
    tool: ToolLabel;
    status: 'succeeded' | 'failed' | 'missing';
    internalMetadata: boolean;
}
interface AssistantFacts {
    hasMarker: boolean;
    textLength: number;
    hasToolCalls: boolean;
}
const facts = {
    passed: false,
    phase: 'setup',
    failureCode: undefined as string | undefined,
    elapsedMs: 0,
    provider: process.env.AOTUI_TEST_PROVIDER || 'deepseek',
    defaultSemanticSource: false,
    legacyCalls: 0,
    modelRequests: [] as RequestFacts[],
    toolResults: [] as ToolResultFacts[],
    assistantMessages: [] as AssistantFacts[],
    markerReceived: false,
    finalFile43: false,
    configurationRowsInTestDatabase: -1,
    cleanupErrors: [] as string[],
};
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
    for (const expected of ['multi_open_file', 'read_loaded_diagnostics', 'edit_file'] as const) {
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
    return { tool: toolLabel(item.toolName), status, internalMetadata };

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
    } catch {
        // execFile errors can contain child stdout; never propagate that object.
        throw new AcceptanceFailure('CONFIG_READ_FAILED');
    }
    requireFact(row && typeof row.model === 'string' && row.model.length > 0
        && typeof row.provider_id === 'string' && typeof row.api_key === 'string'
        && row.api_key.length > 0, 'INVALID_PROVIDER_CONFIG');
    return {
        model: row.model,
        apiKey: row.api_key,
        provider: { id: row.provider_id, ...(typeof row.base_url === 'string' && row.base_url
            ? { baseURL: row.base_url } : {}) },
        temperature: 0,
        maxSteps: MAX_MODEL_REQUESTS,
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
const deadline = setTimeout(() => stopWithFailure('TIME_LIMIT'), MAX_DURATION_MS);
const originalFetch = globalThis.fetch;

// This is a transparent network audit, not a model stub. It also aborts the
// actual provider stream when the overall test deadline or request limit fires.
globalThis.fetch = async (input, init) => {
    networkAbort.signal.throwIfAborted();
    if (typeof init?.body === 'string') {
        let body: Record<string, unknown> | undefined;
        try { body = object(JSON.parse(init.body)); } catch { /* Non-JSON request. */ }
        if (Array.isArray(body?.messages)) {
            if (facts.modelRequests.length >= MAX_MODEL_REQUESTS) {
                stopWithFailure('MODEL_REQUEST_LIMIT');
                throw new AcceptanceFailure('MODEL_REQUEST_LIMIT');
            }
            const userTexts = body.messages.flatMap((message: unknown) => {
                const item = object(message);
                return item?.role === 'user' ? [textContent(item.content)] : [];
            });
            const names = Array.isArray(body.tools) ? body.tools.flatMap((tool: unknown) => {
                const definition = object(object(tool)?.function);
                return typeof definition?.name === 'string' ? [definition.name] : [];
            }) : [];
            facts.modelRequests.push({
                number: facts.modelRequests.length + 1,
                file42Views: userTexts.filter(text => text.includes('<view') && text.includes('export const answer = 42;')).length,
                file43Views: userTexts.filter(text => text.includes('<view') && text.includes('export const answer = 43;')).length,
                openTool: names.some(name => name.includes('multi_open_file')),
                diagnosticsTool: names.some(name => name.includes('read_loaded_diagnostics')),
                editTool: names.some(name => name.includes('edit_file')),
                nonAppTool: names.some(name => name.startsWith('mcp-') || name === 'skill'),
            });
            progress('model-request', { number: facts.modelRequests.length });
        }
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return originalFetch(input, { ...init,
        signal: signal ? AbortSignal.any([networkAbort.signal, signal]) : networkAbort.signal });
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function cleanupStep(label: string, cleanup: () => void | Promise<void>): Promise<void> {
    try { await cleanup(); } catch { facts.cleanupErrors.push(label); }
}

try {
    progress('setup');
    requireFact(factsFile, 'FACTS_OUTPUT_PATH_REQUIRED');
    const llmConfig = loadReadOnlyConfig();
    work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-semantic-host-llm-')));
    const projectPath = path.join(work, 'project');
    await fs.mkdir(projectPath);
    const demoFile = path.join(projectPath, 'demo.ts');
    await fs.writeFile(demoFile, 'export const answer = 42;\n');
    process.env.DB_PATH = path.join(work, 'chat.sqlite');
    process.env.AOTUI_DATA_DIR = path.join(work, 'data');
    delete process.env.AOTUI_HOST_SEMANTIC_DEV;
    delete process.env.AOTUI_HOST_SEMANTIC_PROJECT;
    delete process.env.AOTUI_HOST_SEMANTIC_DATA;

    const { createRuntime, AppRegistry } = await import('@aotui/runtime');
    const { SemanticAOTUIDrivenSource } = await import('@aotui/runtime/adapters');
    const { AgentDriverV2 } = await import('@aotui/agent-driver-v2');
    const { DesktopManager, desktopManager: moduleDesktopManager, desktopManagerReady } = await import('../src/core/desktop-manager.js');
    moduleRuntime = moduleDesktopManager.getKernel();
    const { SessionManagerV3 } = await import('../src/core/session-manager-v3.js');
    const { MessageServiceV2 } = await import('../src/core/message-service-v2.js');
    const { LLMConfigService } = await import('../src/core/llm-config-service.js');
    const { ModelRegistry } = await import('../src/services/model-registry.js');
    const { projectService } = await import('../src/core/project-service.js');
    database = await import('../src/db/index.js');
    // Await the existing module singleton's config read; it creates no Desktop.
    await desktopManagerReady;
    await database.initDatabase();

    class InMemoryLLMConfigService extends LLMConfigService {
        override async getActiveLLMConfig(): Promise<LLMConfig> { return llmConfig; }
    }
    class PrivateTestMessageService extends MessageServiceV2 {
        override addMessage(topicId: string, message: ModelMessage): Message {
            // Session's normal error path attaches raw provider errors. Keep the
            // real persistence service, but never persist those details in a test.
            const metadata = object(object(message)?.metadata);
            if (metadata?.isAgentError === true) {
                stopWithFailure('AGENT_RUN_ERROR');
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
    const legacyForbidden = () => {
        facts.legacyCalls += 1;
        throw new AcceptanceFailure('LEGACY_INTERACTION_USED');
    };
    runtime.acquireSnapshot = legacyForbidden;
    runtime.execute = legacyForbidden;
    const desktopManager = new DesktopManager({ kernel: runtime,
        appRegistry: new AppRegistry({ configPath: path.join(work, 'apps.json') }) });
    await desktopManager.initialize({ loadFromConfig: false, enableDevAutoDiscovery: false, appEntries: [{
        name: 'system_ide', source: `local:${path.join(repo, 'demo-apps/aotui-ide')}`,
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
    manager = new SessionManagerV3(runtime, desktopManager,
        new InMemoryLLMConfigService(new ModelRegistry()), new PrivateTestMessageService(),
        { maxSessions: 1, idleTimeoutMs: MAX_DURATION_MS * 2, cleanupIntervalMs: MAX_DURATION_MS * 2 });
    manager.on('message', (event: GuiUpdateEvent) => {
        if (event.topicId !== topicId || !event.message) return;
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
            const hasMarker = /\bSEMANTIC_OK answer=43\b/u.test(text);
            const hasToolCalls = Array.isArray(event.message.content)
                && event.message.content.some(part => object(part)?.type === 'tool-call');
            const assistantFact = { hasMarker, textLength: text.length, hasToolCalls };
            facts.assistantMessages.push(assistantFact);
            progress('assistant-message', assistantFact);
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
    requireFact(session.agentDriver instanceof AgentDriverV2, 'DEFAULT_AGENT_DRIVER_MISSING');
    facts.defaultSemanticSource = session.sources.aotui instanceof SemanticAOTUIDrivenSource;
    requireFact(facts.defaultSemanticSource, 'DEFAULT_SEMANTIC_SOURCE_MISSING');
    requireFact(desktopManager.getAppIds(session.desktop.id).length === 1, 'DEFAULT_IDE_INSTALLATION_FAILED');

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
    await manager.sendMessage(topicId, [
        'Complete this small acceptance task using only the installed AOTUI IDE tools and current Views.',
        `Open the existing file ${demoFile} with multi_open_file.`,
        'Read its current contents from the resulting FileDetail View and state its initial numeric answer.',
        'Call read_loaded_diagnostics for that opened file at least once.',
        'Then call edit_file to change the exported answer to 43, preserving the rest of the file.',
        'The tool receipt is not the file contents: wait for and read the refreshed FileDetail View after the edit.',
        'Only when that current View contains the updated value, finish with exactly: SEMANTIC_OK answer=43',
        'Do not use shell, MCP, skills, context compaction, or additional apps. Keep the task short.',
    ].join('\n'));
    manager.resumeSession(topicId);
    await finished;
    requireFact(!facts.failureCode, facts.failureCode || 'AGENT_RUN_FAILED');

    facts.phase = 'verification';
    progress('verification');
    facts.finalFile43 = await fs.readFile(demoFile, 'utf8') === 'export const answer = 43;\n';
    requireFact(facts.finalFile43 && facts.markerReceived, 'FINAL_FILE_OR_ANSWER_INCORRECT');
    requireFact(facts.legacyCalls === 0, 'LEGACY_INTERACTION_USED');
    requireFact(facts.modelRequests.length > 0, 'NO_REAL_MODEL_REQUEST');
    const firstRequest = facts.modelRequests[0]!;
    requireFact(firstRequest.openTool && !firstRequest.editTool, 'INITIAL_TOOL_SURFACE_INCORRECT');
    requireFact(facts.modelRequests.some(request => request.file42Views === 1
        && request.editTool && request.diagnosticsTool), 'MODEL_DID_NOT_RECEIVE_OPENED_VIEW');
    requireFact(facts.modelRequests.some(request => request.file43Views === 1 && request.file42Views === 0),
        'MODEL_DID_NOT_RECEIVE_LATEST_VIEW');
    requireFact(!facts.modelRequests.some(request => request.nonAppTool), 'DISABLED_SOURCE_TOOLS_EXPOSED');
    for (const expected of ['multi_open_file', 'read_loaded_diagnostics', 'edit_file'] as const) {
        requireFact(facts.toolResults.some(receipt => receipt.tool === expected
            && receipt.status === 'succeeded' && !receipt.internalMetadata), `MISSING_SUCCESSFUL_${expected.toUpperCase()}`);
    }
    requireFact(!facts.toolResults.some(receipt => receipt.status !== 'succeeded'), 'NON_SUCCESSFUL_TOOL_RESULT');
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
    await cleanupStep('runtime', async () => { await runtime?.shutdown('semantic-host-llm-e2e'); });
    await cleanupStep('module-runtime', async () => { await moduleRuntime?.shutdown('semantic-host-llm-e2e-module'); });
    await cleanupStep('database', () => { database?.closeDatabase(); });
    await cleanupStep('temporary-files', async () => { if (work) await fs.rm(work, { recursive: true, force: true }); });
    facts.elapsedMs = Date.now() - startedAt;
    if (facts.cleanupErrors.length > 0) {
        facts.passed = false;
        facts.failureCode ??= 'CLEANUP_FAILED';
    }
    if (factsFile) {
        try { await fs.writeFile(factsFile, JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 }); }
        catch { facts.passed = false; facts.failureCode = 'FACTS_WRITE_FAILED'; }
    }
    // Keep the aborting fetch and muted product logger until this isolated
    // process exits, so late SDK retries cannot restart a call or log an error.
    process.stdout.write(JSON.stringify({ passed: facts.passed, failureCode: facts.failureCode,
        modelRequests: facts.modelRequests.length, toolResults: facts.toolResults.length, elapsedMs: facts.elapsedMs }) + '\n');
    process.exit(facts.passed ? 0 : 1);
}
