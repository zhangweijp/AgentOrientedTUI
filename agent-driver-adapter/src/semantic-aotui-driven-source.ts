import { createHash } from 'node:crypto';
import { jsonSchema, type Tool } from '@aotui/agent-driver-v2';
import { buildViewMessageMarkup } from '@aotui/runtime/adapters';
import { buildPublicToolName } from '@aotui/runtime/adapters';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { loadAOTUIInstruction } from './load-aotui-instruction.js';
import { formatAppStatus, formatTimestamp } from './presentation.js';
import type { ObservedToolExecutionV3, ToolDescriptorV3 } from '@aotui/runtime/core';
import type { ContextDrivenSource, DrivenSourceContext, MessageWithTimestamp, ToolResult } from '@aotui/agent-driver-v2';
import type { AppID } from '@aotui/runtime/spi';
import type { IDesktop, IKernel, AppDiscoveryInfo } from '@aotui/runtime/spi';
import type { Observation } from '@aotui/runtime/core';
import type { InvokeResult, ScopeClient, ScopePolicy } from '@aotui/runtime/core';

export interface SemanticAOTUIDrivenSourceOptions {
    includeInstruction?: boolean;
    instruction?: string;
    instructionPath?: string;
    /** Trusted Host policy; applications and model arguments cannot supply it. */
    policy?: (app: AppDiscoveryInfo) => ScopePolicy;
    maxActiveContexts?: number;
    maxApps?: number;
}

const key = (value: string) => value.trim().toLowerCase();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (toolName: string, toolCallId: string, code: string, message: string, outcomeStatus: 'rejected' | 'unknown' = 'rejected'): ToolResult =>
    ({ toolName, toolCallId, outcomeStatus, error: { code, message } });

/** Keep Core receipts internal while returning Tool result data and actionable errors to the Driver. */
function semanticToolResult(toolName: string, toolCallId: string, result: InvokeResult): ToolResult {
    if (result.kind !== 'receipt') return unavailable(toolName, toolCallId, result.code, result.message,
        result.kind === 'refused' ? 'rejected' : 'unknown');
    const outcome = result.receipt.outcome;
    const base = { toolName, toolCallId, outcomeStatus: outcome.status };
    if (outcome.status === 'succeeded') {
        const value = outcome.value;
        return { ...base, result: object(value) && value.success === true ? value.data ?? { success: true } : value ?? { success: true } };
    }
    const business = outcome.details?.kind === 'tool-result' ? outcome.details.result : undefined;
    return {
        ...base,
        ...(business?.data === undefined ? {} : { result: business.data }),
        error: { code: business?.error?.code ?? outcome.code,
            message: (business?.error?.message ?? outcome.message) + (outcome.status === 'failed' && outcome.effects === 'partial'
                ? ' Some changes were applied. Inspect the current View before retrying.' : '') },
    };
}

interface AppScope { app: AppDiscoveryInfo; client: ScopeClient }
interface Binding { app: AppDiscoveryInfo; client: ScopeClient; observationId: string; bindingId: string; execution: ObservedToolExecutionV3 }
interface ToolGroup { app: AppDiscoveryInfo; tool: ToolDescriptorV3; bindings: Map<string, Binding> }
interface AppIssue { code: string; message: string }
interface CapturedObservation { client: ScopeClient; observation: Observation; released: boolean }
interface AppProjection {
    app: AppDiscoveryInfo;
    captured: CapturedObservation;
    messages: MessageWithTimestamp[];
    tools: Map<string, Tool>;
    bindings: Map<string, ToolGroup>;
    presentations: Map<string, { digest: string; timestamp: number }>;
}

interface ContextOwner { appIds: Set<string>; release(): void }

class AppProjectionError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

function boundedIssue(code: string, message: string): AppIssue {
    const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'AOTUI_APP_PROJECTION_FAILED';
    const safeMessage = [...message.replace(/[\r\n\t]/g, ' ').replace(/[&<>]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
    })[character]!)].slice(0, 220).join('');
    return { code: safeCode, message: safeMessage };
}

function appIssueFrom(error: unknown): AppIssue {
    if (error instanceof AppProjectionError) return boundedIssue(error.code, error.message);
    const message = error instanceof Error ? error.message : '';
    const code = message.match(/^([A-Z][A-Z0-9_]{0,63}):/)?.[1];
    if (code === 'AOTUI_TOOL_NAME_INVALID' ||
        code === 'AOTUI_TOOL_NAME_COLLISION' || code === 'TOOL_TARGET_REQUIRED' ||
        code === 'TOOL_SOURCE_CONFLICT' || code === 'TOOL_TARGET_CONFLICT') {
        return boundedIssue(code, message.replace(new RegExp(`^${code}:\\s*`), ''));
    }
    return boundedIssue('AOTUI_APP_PROJECTION_FAILED',
        'This App projection is invalid; repair its View or Tool declarations, then refresh the context.');
}

function releaseCaptured(captured: CapturedObservation): void {
    if (captured.released) return;
    captured.released = true;
    captured.client.releaseObservation(captured.observation.observationId);
}

/**
 * Generic Runtime → Agent adapter. No App-specific View names, tool allowlists,
 * direct Worker execution, or automatic rebinding of old calls.
 * A getContext() result owns its Observations until release(), including while
 * the model thinks. A later context cannot overwrite an earlier call target.
 * Scopes are owned by the active Contexts, and close when their last owner
 * releases. Core receipts stay internal; public results carry Tool result data
 * or actionable errors. Model-facing Tools are expected to await completion.
 */
export class SemanticAOTUIDrivenSource implements ContextDrivenSource {
    readonly name = 'AOTUI';
    private enabled = true;
    private disposed = false;
    private generation = 0;
    private readonly disabledApps = new Set<string>();
    private readonly scopes = new Map<string, AppScope>();
    private readonly contexts = new Set<ContextOwner>();
    private readonly listeners = new Set<() => void>();
    private readonly update = () => { for (const listener of this.listeners) listener(); };
    private subscribed = false;
    private readonly maxActiveContexts: number;
    private readonly maxApps: number;
    private readonly instruction: string;
    private presentations = new Map<string, { digest: string; timestamp: number }>();

    constructor(private readonly desktop: IDesktop, private readonly kernel: IKernel,
        private readonly options: SemanticAOTUIDrivenSourceOptions = {}) {
        this.maxActiveContexts = options.maxActiveContexts ?? 8;
        this.maxApps = options.maxApps ?? 128;
        this.instruction = loadAOTUIInstruction(options, DEFAULT_AOTUI_SYSTEM_INSTRUCTION);
        for (const limit of [this.maxActiveContexts, this.maxApps]) {
            if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('SEMANTIC_SOURCE_LIMIT_INVALID');
        }
        if (typeof desktop.getInstalledApps !== 'function' || typeof kernel.createAppScope !== 'function')
            throw new Error('SEMANTIC_RUNTIME_UNSUPPORTED');
    }

    listApps(): readonly AppDiscoveryInfo[] {
        if (this.disposed) return [];
        const apps = this.desktop.getInstalledApps();
        if (apps.length > this.maxApps) throw new Error('SEMANTIC_APP_CAPACITY');
        // Do not expose launch configuration, paths, credentials, or mutable registry records.
        return apps.map(app => ({ appId: app.appId, ...(app.appInstanceId ? { appInstanceId: app.appInstanceId } : {}),
            name: app.name, status: app.status,
            description: app.description, whatItIs: app.whatItIs, whenToUse: app.whenToUse }));
    }

    private currentApp(appId: string): AppDiscoveryInfo | undefined {
        for (const candidate of this.desktop.getInstalledApps()) {
            let candidateId: string;
            try {
                if (!object(candidate)) continue;
                const descriptor = Object.getOwnPropertyDescriptor(candidate, 'appId');
                if (!descriptor || !('value' in descriptor)) continue;
                candidateId = String(descriptor.value);
            } catch { continue; }
            if (candidateId !== appId) continue;
            try {
                const fields = Object.getOwnPropertyDescriptors(candidate);
                const value = (key: string) => {
                    const descriptor = fields[key];
                    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
                };
                const status = value('status');
                if (!['pending', 'running', 'paused', 'closed', 'collapsed'].includes(status as string)) return undefined;
                const appInstanceId = value('appInstanceId');
                return { appId: candidateId as AppID, status: status as AppDiscoveryInfo['status'],
                    ...(typeof appInstanceId === 'string' ? { appInstanceId } : {}) };
            } catch { return undefined; }
        }
        return undefined;
    }

    private allowed(app: AppDiscoveryInfo): boolean {
        return this.enabled && !this.disposed && !this.disabledApps.has(key(String(app.appId))) &&
            (!app.name || !this.disabledApps.has(key(app.name)));
    }

    private policy(app: AppDiscoveryInfo): ScopePolicy {
        const custom = this.options.policy?.(app);
        return {
            project: context => {
                if (!this.allowed(app)) return { views: [], refs: [], toolBindings: [], content: [] };
                if (custom) return custom.project(context);
                const selected = new Set(context.selection.viewIds);
                const views = context.source.views.filter(view => selected.has(view.id));
                const owners = new Set(views.map(view => JSON.stringify([view.id, view.viewInstanceId])));
                const toolBindings: Array<{ toolId: string; execution: ObservedToolExecutionV3 }> = [];
                for (const tool of Object.values(context.source.tools)) {
                    if (tool.execution.kind === 'view-type') {
                        if (views.some(view => view.type === tool.viewType)) {
                            toolBindings.push({ toolId: tool.id, execution: {
                                kind: 'view-type', activationId: tool.execution.activationId,
                            } });
                        }
                        continue;
                    }
                }
                return {
                    views: views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                    refs: Object.values(context.source.refs)
                        .filter(ref => owners.has(JSON.stringify([ref.ownerViewId, ref.ownerViewInstanceId])))
                        .map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
                    toolBindings,
                    content: views.map(view => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' as const })),
                };
            },
            authorize: context => this.allowed(app) && (custom ? custom.authorize(context) : true),
            canReadReceipt: (metadata, signal) => this.allowed(app) && (custom ? custom.canReadReceipt(metadata, signal) : true),
        };
    }

    private openScope(app: AppDiscoveryInfo): AppScope | { issue: string } {
        const existing = this.scopes.get(String(app.appId));
        if (existing) return existing;
        const result = this.kernel.createAppScope(this.desktop.id, String(app.appId), this.policy(app));
        if (result.status !== 'opened') return { issue: result.issue.code };
        const scope = { app, client: result.client };
        this.scopes.set(String(app.appId), scope);
        return scope;
    }

    private retire(appId: string): void {
        const scope = this.scopes.get(appId);
        if (scope) { this.scopes.delete(appId); scope.client.close(); }
    }

    private retireUnownedScopes(): void {
        for (const appId of this.scopes.keys()) {
            if (![...this.contexts].some(owner => owner.appIds.has(appId))) this.retire(appId);
        }
    }

    async getContext(): Promise<DrivenSourceContext> {
        if (this.disposed || !this.enabled) return { messages: [], tools: {} };
        if (this.contexts.size >= this.maxActiveContexts) throw new Error('SEMANTIC_CONTEXT_CAPACITY');
        const generation = this.generation;
        const observations: CapturedObservation[] = [];
        let released = false;
        let adopted = false;
        const owner: ContextOwner = { appIds: new Set(), release: () => {
            if (released) return;
            released = true;
            for (const observed of observations) releaseCaptured(observed);
            this.contexts.delete(owner);
            this.retireUnownedScopes();
        } };
        this.contexts.add(owner);
        try {
            const installedApps = this.listApps();
            const apps = installedApps.filter(app => this.allowed(app));
            const active = new Set(apps.filter(app => app.status === 'running').map(app => String(app.appId)));
            for (const appId of this.scopes.keys()) if (!active.has(appId)) this.retire(appId);
            const messages: MessageWithTimestamp[] = [];
            const tools: Record<string, Tool> = {};
            const bindings = new Map<string, ToolGroup>();
            const presentations = new Map<string, { digest: string; timestamp: number }>();
            const timestamp = (target: Map<string, { digest: string; timestamp: number }>, id: string, content: string) => {
                const digest = createHash('sha256').update(content).digest('hex');
                const previous = this.presentations.get(id);
                const entry = previous?.digest === digest ? previous : { digest, timestamp: Date.now() };
                target.set(id, entry);
                return entry.timestamp;
            };
            const issues = new Map<string, AppIssue>();
            const projections: AppProjection[] = [];
            if (this.options.includeInstruction !== false) messages.push({ role: 'user', content: this.instruction, timestamp: 1, region: 'static' });
            for (const app of apps) {
                const appId = String(app.appId);
                if (!active.has(appId)) continue;
                let scope: AppScope | undefined;
                let observation: Observation | undefined;
                try {
                    const opened = this.openScope(app);
                    if ('issue' in opened) {
                        issues.set(appId, boundedIssue(opened.issue,
                            `The Runtime could not open this App scope (${opened.issue}); repair the App or refresh the context.`));
                        continue;
                    }
                    scope = opened;
                    owner.appIds.add(appId);
                    let observed = await scope.client.observe({ all: true });
                    // Reopen only while constructing a NEW observation. Calls from an
                    // earlier context always retain their original client and binding.
                    if (observed.status === 'rejected' && observed.issue.code === 'SCOPE_UNAVAILABLE') {
                        owner.appIds.delete(appId);
                        this.retire(appId);
                        this.retireUnownedScopes();
                        const reopened = this.openScope(app);
                        if ('issue' in reopened) {
                            issues.set(appId, boundedIssue(reopened.issue,
                                `The Runtime could not reopen this App scope (${reopened.issue}); refresh the context.`));
                            continue;
                        }
                        scope = reopened;
                        owner.appIds.add(appId);
                        observed = await scope.client.observe({ all: true });
                    }
                    if (observed.status !== 'observed') {
                        throw new AppProjectionError(observed.issue.code,
                            `The Runtime rejected this App observation (${observed.issue.code}); repair its projection or refresh the context.`);
                    }
                    observation = observed.observation;
                    if (released || this.generation !== generation) {
                        scope.client.releaseObservation(observation.observationId);
                        owner.appIds.delete(appId);
                        this.retireUnownedScopes();
                        continue;
                    }

                    const byId = new Map<string, ToolGroup>(observation.tools.map(tool => [tool.id,
                        { app, tool, bindings: new Map<string, Binding>() }]));
                    if (byId.size !== observation.tools.length)
                        throw new AppProjectionError('AOTUI_APP_PROJECTION_INVALID', 'The App declared duplicate Tool identities.');
                    for (const sourceBinding of observation.bindings) {
                        const group = byId.get(sourceBinding.toolId);
                        if (!group) throw new AppProjectionError('AOTUI_APP_PROJECTION_INVALID', 'The App observation contains a Tool binding without a Tool declaration.');
                        if (sourceBinding.execution.kind === 'view-type') {
                            if (group.tool.execution.kind !== 'view-type' || group.tool.execution.activationId !== sourceBinding.execution.activationId ||
                                group.bindings.size > 0) throw new AppProjectionError('TOOL_SOURCE_CONFLICT', 'The App ViewType Tool binding does not match its observation.');
                            const value = 'view-type:' + sourceBinding.execution.activationId;
                            group.bindings.set(value, { app, client: scope.client, observationId: observation.observationId,
                                bindingId: sourceBinding.bindingId, execution: sourceBinding.execution });
                            continue;
                        }
                        throw new AppProjectionError('TOOL_SOURCE_CONFLICT', 'The App observation contains an unsupported Tool execution kind.');
                    }

                    const localGroups = [...byId.values()].filter(group => group.bindings.size);
                    const localMessages: MessageWithTimestamp[] = [];
                    const localTools = new Map<string, Tool>();
                    const localBindings = new Map<string, ToolGroup>();
                    const localPresentations = new Map<string, { digest: string; timestamp: number }>();
                    for (const view of observation.views) {
                        if (!view.content) continue;
                        const content = view.content.format === 'markdown-v1' ? view.content.value : JSON.stringify(view.content.value);
                        const refs = observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId);
                        const markup = buildViewMessageMarkup({ appId, appName: app.name || appId,
                            viewId: view.id, viewType: view.type, kind: view.kind, viewName: view.name, markup: content,
                            suffix: refs.length ? '\n\nAvailable references: ' + refs.map(ref => `${ref.refId} (${ref.refType})`).join(', ') : '' });
                        localMessages.push({ role: 'user', region: view.kind === 'instruction' ? 'static' : 'dynamic',
                            timestamp: timestamp(localPresentations, JSON.stringify([app.appId, view.viewInstanceId]), markup), content: markup });
                    }
                    for (const group of localGroups) {
                        const name = buildPublicToolName(group.app.name || appId, group.tool.viewType, group.tool.name);
                        if (localBindings.has(name)) throw new AppProjectionError('AOTUI_TOOL_NAME_COLLISION',
                            `Public Tool alias ${JSON.stringify(name)} is declared more than once by this App. Rename its ViewType or Tool.`);
                        if (!object(group.tool.inputSchema)) throw new AppProjectionError('AOTUI_TOOL_SCHEMA_INVALID',
                            'This App Tool has an invalid input schema. Declare a JSON Schema object and refresh the context.');
                        let inputSchema: ReturnType<typeof jsonSchema>;
                        try { inputSchema = jsonSchema(group.tool.inputSchema); }
                        catch { throw new AppProjectionError('AOTUI_TOOL_SCHEMA_INVALID',
                            'This App Tool schema is not supported by the Agent Driver. Simplify its JSON Schema and refresh the context.'); }
                        localBindings.set(name, group);
                        localTools.set(name, { description: `${group.tool.description}\nApplication: ${group.app.name || appId}; View type: ${group.tool.viewType}.`,
                            inputSchema });
                    }
                    const captured: CapturedObservation = { client: scope.client, observation, released: false };
                    observations.push(captured);
                    projections.push({ app, captured, messages: localMessages, tools: localTools, bindings: localBindings,
                        presentations: localPresentations });
                } catch (error) {
                    if (observation && scope) scope.client.releaseObservation(observation.observationId);
                    owner.appIds.delete(appId);
                    this.retireUnownedScopes();
                    issues.set(appId, appIssueFrom(error));
                }
            }

            // Sort only for deterministic collision ownership. Context presentation
            // retains the Desktop's original App order after the winners are known.
            const collisionOrder = [...projections].sort((left, right) => {
                const a = String(left.app.appId), b = String(right.app.appId);
                return a < b ? -1 : a > b ? 1 : 0;
            });
            const accepted = new Set<AppProjection>();
            const nameOwners = new Map<string, string>();
            for (const projection of collisionOrder) {
                const conflict = [...projection.tools.keys()].find(name => nameOwners.has(name));
                if (conflict) {
                    const appId = String(projection.app.appId);
                    issues.set(appId, boundedIssue('AOTUI_TOOL_NAME_COLLISION',
                        `Public Tool alias ${JSON.stringify(conflict)} collides with another App. Rename this App, ViewType, or Tool.`));
                    releaseCaptured(projection.captured);
                    owner.appIds.delete(appId);
                    this.retireUnownedScopes();
                    continue;
                }
                accepted.add(projection);
                for (const name of projection.tools.keys()) nameOwners.set(name, String(projection.app.appId));
            }
            for (const projection of projections) {
                if (!accepted.has(projection)) continue;
                messages.push(...projection.messages);
                for (const [name, tool] of projection.tools) {
                    tools[name] = tool;
                    bindings.set(name, projection.bindings.get(name)!);
                }
                for (const [id, entry] of projection.presentations) presentations.set(id, entry);
            }
            // Logs are Desktop-wide metadata, not application-projected content.
            // Do not reveal disabled applications through unscoped log text.
            let logs: readonly { timestamp: number; message: string }[] = [];
            if (!this.disabledApps.size) {
                try { logs = this.desktop.getSystemLogs?.().slice(-5) ?? []; } catch { /* optional metadata */ }
            }
            const desktopMarkup = `<desktop>\n\n## Installed TUI Applications\n${apps.length ? apps.map((app, index) => [
                `${index + 1}. ${app.name || app.appId}`, `    - App ID: ${app.appId}`,
                `    - Status: ${formatAppStatus(app.status)}`, `    - What it is: ${app.whatItIs || app.description || 'Not provided'}`,
                `    - When to use: ${app.whenToUse || 'Not provided'}`,
                ...(issues.has(String(app.appId)) ? [`    - Semantic status: ${issues.get(String(app.appId))!.code}: ${issues.get(String(app.appId))!.message}`] : []),
            ].join('\n')).join('\n') : installedApps.length ? '- No applications enabled for this context.' : '- No applications installed.'}\n\n## System Logs\n${logs.length ? logs.map(log => `- [${formatTimestamp(log.timestamp)}] ${log.message}`).join('\n') : this.disabledApps.size ? '- Desktop-wide logs are hidden while application filtering is active.' : '- No recent activity.'}\n\n</desktop>`;
            messages.push({ role: 'user', region: 'dynamic', content: desktopMarkup,
                timestamp: timestamp(presentations, 'desktop', desktopMarkup) });
            const control = this.controls(apps, tools);
            if (released || this.generation !== generation) { owner.release(); return { messages: [], tools: {} }; }
            this.presentations = presentations;
            return { messages, tools, release: owner.release,
                adopt: () => {
                    if (released || this.disposed || !this.enabled || this.generation !== generation)
                        throw Object.assign(new Error('This prepared context is no longer available.'), { code: 'SEMANTIC_CONTEXT_RELEASED' });
                    if (adopted) return;
                    const results = observations.filter(item => !item.released).map(item => {
                        try {
                            const result = item.client.adoptObservation(item.observation.observationId);
                            return Object.freeze({ appId: item.observation.source.appId, ...result });
                        } catch {
                            return Object.freeze({ appId: item.observation.source.appId, status: 'rejected' as const,
                                issue: { code: 'OBSERVATION_ADOPTION_FAILED', message: 'App observation adoption failed.' } });
                        }
                    });
                    const succeeded = results.some(result => result.status === 'adopted');
                    const failed = results.some(result => result.status === 'rejected');
                    // A partial handover cannot restore already revoked qualifications.
                    // Keep the App results explicit and let Driver's finally close this turn.
                    if (!failed || succeeded) for (const previous of this.contexts) if (previous !== owner) previous.release();
                    if (failed) {
                        owner.release();
                        throw Object.assign(new Error('The prepared context could not be adopted.'), {
                            code: succeeded ? 'SEMANTIC_ADOPTION_PARTIAL' : 'SEMANTIC_ADOPTION_FAILED', results: Object.freeze(results),
                        });
                    }
                    adopted = true;
                },
                executeTool: async (name, args, callId) => {
                    if (released || this.disposed || !this.enabled) return name in tools ? unavailable(name, callId, 'SEMANTIC_CONTEXT_RELEASED', 'This observation was released; obtain a new context.') : undefined;
                    if (!adopted) return name in tools ? unavailable(name, callId, 'SEMANTIC_CONTEXT_NOT_ADOPTED', 'Adopt this prepared context before invoking its tools.') : undefined;
                    const handler = control.get(name);
                    if (handler) return handler(args, callId);
                    const group = bindings.get(name);
                    if (!group) return undefined;
                    if (!this.allowed(group.app)) return unavailable(name, callId, 'APP_DISABLED', 'This application is disabled.');
                    if (!object(args)) return unavailable(name, callId, 'INVOCATION_INVALID', 'Tool input must be an object.');
                    const fields = Object.getOwnPropertyDescriptors(args);
                    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !fields[key]!.enumerable || !('value' in fields[key]!)))
                        return unavailable(name, callId, 'INVOCATION_INVALID', 'Tool input must contain ordinary JSON properties.');
                    const binding = group.bindings.get('view-type:' + group.tool.execution.activationId);
                    if (!binding) return unavailable(name, callId, 'TOOL_UNAVAILABLE', 'The observed Tool binding is unavailable.');
                    try { return semanticToolResult(name, callId, await binding.client.invoke({ invocationId: callId,
                        observationId: binding.observationId, bindingId: binding.bindingId, input: args })); }
                    catch { return unavailable(name, callId, 'INVOCATION_RESULT_UNKNOWN', 'Execution could not be confirmed. Do not blindly retry.', 'unknown'); }
                },
            };
        } catch (error) { owner.release(); throw error; }
    }

    private controls(apps: readonly AppDiscoveryInfo[], tools: Record<string, Tool>): Map<string, (input: unknown, callId: string) => Promise<ToolResult>> {
        const handlers = new Map<string, (input: unknown, callId: string) => Promise<ToolResult>>();
        const actions: Array<{ action: string; statuses: readonly AppDiscoveryInfo['status'][]; description: string;
            instanceBound: boolean; execute: (id: AppID, expectedInstanceId?: string) => Promise<void> }> = [
            { action: 'open', statuses: ['pending', 'closed'], description: 'Start an installed application.', instanceBound: false,
                execute: id => this.desktop.openApp(id) },
            { action: 'close', statuses: ['running', 'collapsed', 'paused'], description: 'Close an application and revoke its current tools.', instanceBound: true,
                execute: (id, instanceId) => this.desktop.closeApp(id, instanceId) },
            { action: 'collapse', statuses: ['running'], description: 'Collapse an application.', instanceBound: true,
                execute: (id, instanceId) => this.desktop.collapseApp(id, instanceId) },
            { action: 'show', statuses: ['collapsed'], description: 'Show a collapsed application.', instanceBound: true,
                execute: (id, instanceId) => this.desktop.showApp(id, instanceId) },
        ];
        for (const { action, statuses, description, instanceBound, execute } of actions) {
            const available = apps.filter(app => statuses.includes(app.status) && (!instanceBound ||
                (typeof app.appInstanceId === 'string' && app.appInstanceId.length > 0)));
            if (!available.length) continue;
            const name = `system-${action}_app`, ids = new Set(available.map(app => String(app.appId)));
            const instances = new Map(available.map(app => [String(app.appId), app.appInstanceId]));
            const capturedApps = new Map(available.map(app => [String(app.appId), app]));
            tools[name] = { description, inputSchema: jsonSchema({ type: 'object', properties: { app_id: { type: 'string', enum: [...ids] } }, required: ['app_id'], additionalProperties: false }) };
            handlers.set(name, async (input, callId) => {
                if (!object(input) || Object.keys(input).length !== 1 || typeof input.app_id !== 'string' || !ids.has(input.app_id))
                    return unavailable(name, callId, 'INVALID_APP_TARGET', 'Select an application from this observation.');
                const app = this.currentApp(input.app_id), captured = capturedApps.get(input.app_id);
                if (!app || !captured || !this.allowed(captured) || !(statuses as readonly string[]).includes(app.status))
                    return unavailable(name, callId, 'APP_STATE_CHANGED', 'The application state changed; refresh the context.');
                const expectedInstanceId = instanceBound ? instances.get(input.app_id) : undefined;
                if (instanceBound && (!expectedInstanceId || app.appInstanceId !== expectedInstanceId))
                    return unavailable(name, callId, 'APP_INSTANCE_CHANGED', 'The application instance changed; refresh the context.');
                try { await execute(app.appId, expectedInstanceId); this.update(); return { toolName: name, toolCallId: callId, outcomeStatus: 'succeeded', result: { success: true } }; }
                catch (error) {
                    if (instanceBound && object(error) && error.code === 'APP_INSTANCE_CHANGED')
                        return unavailable(name, callId, 'APP_INSTANCE_CHANGED', 'The application instance changed; refresh the context.');
                    return unavailable(name, callId, 'APP_LIFECYCLE_UNKNOWN', 'Application lifecycle completion could not be confirmed.', 'unknown');
                }
            });
        }
        return handlers;
    }

    setEnabled(enabled: boolean): void {
        if (this.disposed || this.enabled === enabled) return;
        this.enabled = enabled; this.generation++; this.presentations.clear();
        if (!enabled) { for (const owner of this.contexts) owner.release(); for (const id of this.scopes.keys()) this.retire(id); }
        this.update();
    }
    setAppEnabled(appName: string, enabled: boolean): void {
        if (this.disposed || !key(appName)) return;
        if (enabled) this.disabledApps.delete(key(appName)); else this.disabledApps.add(key(appName));
        this.generation++; this.presentations.clear();
        for (const [id, scope] of this.scopes) if (!this.allowed(scope.app)) this.retire(id);
        this.update();
    }
    onUpdate(callback: () => void): () => void {
        if (this.disposed) throw new Error('SEMANTIC_SOURCE_DISPOSED');
        this.listeners.add(callback);
        if (!this.subscribed) { this.desktop.output.subscribe(this.update); this.subscribed = true; }
        return () => {
            this.listeners.delete(callback);
            if (!this.listeners.size && this.subscribed) { this.desktop.output.unsubscribe(this.update); this.subscribed = false; }
        };
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.generation++; this.presentations.clear();
        for (const owner of this.contexts) owner.release();
        for (const id of this.scopes.keys()) this.retire(id);
        if (this.subscribed) this.desktop.output.unsubscribe(this.update);
        this.subscribed = false; this.listeners.clear();
    }
}
