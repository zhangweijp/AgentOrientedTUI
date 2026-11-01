import { createHash } from 'node:crypto';
import { jsonSchema, type Tool } from '@aotui/agent-driver-v2';
import { buildViewMessageMarkup } from './view-message.js';
import { buildPublicToolName } from './public-tool-name.js';
import { loadAOTUIInstruction, DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from './system-instruction.js';
import { formatAppStatus, formatTimestamp } from '../core/presentation.js';
import type { ToolDescriptorV2 } from '../core/snapshot/types.js';
import type { ContextDrivenSource, DrivenSourceContext, MessageWithTimestamp, ToolResult } from '@aotui/agent-driver-v2';
import type { AppID } from '../spi/core/types.js';
import type { IDesktop, IKernel, AppDiscoveryInfo } from '../spi/runtime/kernel.interface.js';
import type { Observation } from '../core/invocation/observation-types.js';
import type { InvokeResult, ReceiptAccess, ScopeClient, ScopePolicy } from '../core/invocation/scoped-interaction-types.js';

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

/** Keep Core receipts internal while returning operation data and actionable errors to the Driver. */
export function semanticToolResult(toolName: string, toolCallId: string, result: InvokeResult | ReceiptAccess): ToolResult {
    if (result.kind !== 'receipt') return unavailable(toolName, toolCallId, result.code, result.message,
        result.kind === 'refused' ? 'rejected' : 'unknown');
    const outcome = result.receipt.outcome;
    const base = { toolName, toolCallId, outcomeStatus: outcome.status };
    if (outcome.status === 'succeeded') {
        const value = outcome.value;
        return { ...base, result: object(value) && value.success === true ? value.data ?? { success: true } : value ?? { success: true } };
    }
    if (outcome.status === 'accepted') return { ...base, error: { code: 'TOOL_RESULT_NOT_FINAL',
        message: 'This Tool did not provide a completed result. Check its application View before another invocation; do not repeat the operation.' } };
    const business = outcome.details?.kind === 'operation-result' ? outcome.details.result : undefined;
    return {
        ...base,
        ...(business?.data === undefined ? {} : { result: business.data }),
        error: { code: business?.error?.code ?? outcome.code,
            message: (business?.error?.message ?? outcome.message) + (outcome.status === 'failed' && outcome.effects === 'partial'
                ? ' Some changes were applied. Inspect the current View before retrying.' : '') },
    };
}

interface AppScope { app: AppDiscoveryInfo; client: ScopeClient }
interface Binding { app: AppDiscoveryInfo; client: ScopeClient; observationId: string; bindingId: string; viewId: string }
interface ToolGroup { app: AppDiscoveryInfo; tool: ToolDescriptorV2; targets: Map<string, Binding>; selector?: string }

interface ContextOwner { release(): void }

/**
 * Generic Runtime → Agent adapter. No App-specific View names, tool allowlists,
 * direct Worker execution, or automatic rebinding of old calls.
 * A getContext() result owns its Observations until release(), including while
 * the model thinks. A later context cannot overwrite an earlier call target.
 * Scopes are owned by the active Contexts, and close when their last owner
 * releases. Core receipts stay internal; public results carry operation data
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

    private allowed(app: AppDiscoveryInfo): boolean {
        return this.enabled && !this.disposed && !this.disabledApps.has(key(String(app.appId))) &&
            (!app.name || !this.disabledApps.has(key(app.name)));
    }

    private policy(app: AppDiscoveryInfo): ScopePolicy {
        const custom = this.options.policy?.(app);
        return {
            project: context => {
                if (!this.allowed(app)) return { views: [], refs: [], targets: [], content: [] };
                if (custom) return custom.project(context);
                const selected = new Set(context.selection.viewIds);
                const views = context.source.views.filter(view => selected.has(view.id));
                const owners = new Set(views.map(view => JSON.stringify([view.id, view.viewInstanceId])));
                return {
                    views: views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
                    refs: Object.values(context.source.refs)
                        .filter(ref => owners.has(JSON.stringify([ref.ownerViewId, ref.ownerViewInstanceId])))
                        .map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
                    targets: Object.values(context.source.tools).flatMap(tool => tool.targets
                        .filter(target => owners.has(JSON.stringify([target.viewId, target.viewInstanceId])))
                        .map(target => ({ toolId: tool.id, target }))),
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

    async getContext(): Promise<DrivenSourceContext> {
        if (this.disposed || !this.enabled) return { messages: [], tools: {} };
        if (this.contexts.size >= this.maxActiveContexts) throw new Error('SEMANTIC_CONTEXT_CAPACITY');
        const generation = this.generation;
        const observations: Array<{ client: ScopeClient; observation: Observation }> = [];
        let released = false;
        const owner: ContextOwner = { release: () => {
            if (released) return;
            released = true;
            for (const observed of observations) observed.client.releaseObservation(observed.observation.observationId);
            this.contexts.delete(owner);
            if (this.contexts.size === 0) for (const appId of this.scopes.keys()) this.retire(appId);
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
            const groups: ToolGroup[] = [];
            const presentations = new Map<string, { digest: string; timestamp: number }>();
            const timestamp = (id: string, content: string) => {
                const digest = createHash('sha256').update(content).digest('hex');
                const previous = this.presentations.get(id);
                const entry = previous?.digest === digest ? previous : { digest, timestamp: Date.now() };
                presentations.set(id, entry);
                return entry.timestamp;
            };
            const issues = new Map<string, string>();
            if (this.options.includeInstruction !== false) messages.push({ role: 'user', content: this.instruction, timestamp: 1, region: 'static' });
            for (const app of apps) {
                if (!active.has(String(app.appId))) continue;
                let scope = this.openScope(app);
                if ('issue' in scope) { issues.set(String(app.appId), scope.issue); continue; }
                let observed = await scope.client.observe({ all: true });
                // Reopen only while constructing a NEW observation. Calls from an
                // earlier context always retain their original client and binding.
                if (observed.status === 'rejected' && observed.issue.code === 'SCOPE_UNAVAILABLE') {
                    this.retire(String(app.appId));
                    scope = this.openScope(app);
                    if ('issue' in scope) { issues.set(String(app.appId), scope.issue); continue; }
                    observed = await scope.client.observe({ all: true });
                }
                if (observed.status !== 'observed') { issues.set(String(app.appId), observed.issue.code); continue; }
                const observation = observed.observation;
                observations.push({ client: scope.client, observation });
                if (released || this.generation !== generation) { scope.client.releaseObservation(observation.observationId); continue; }
                const byId = new Map<string, ToolGroup>(observation.tools.map(tool => [tool.id, { app, tool, targets: new Map<string, Binding>() }]));
                for (const binding of observation.bindings) {
                    const group = byId.get(binding.toolId);
                    const selector = binding.target.selector, value = selector?.value ?? binding.target.viewId;
                    if (!group || group.targets.has(value)) throw new Error('TOOL_TARGET_CONFLICT: Each target parameter value must identify one observed View.');
                    if (group.targets.size && group.selector !== selector?.param)
                        throw new Error('TOOL_TARGET_CONFLICT: Same-type Tools must declare the same target parameter.');
                    group.selector = selector?.param;
                    group.targets.set(value, { app, client: scope.client, viewId: binding.target.viewId,
                        observationId: observation.observationId, bindingId: binding.bindingId });
                }
                groups.push(...[...byId.values()].filter(group => group.targets.size));
                for (const view of observation.views) {
                    if (!view.content) continue;
                    const content = view.content.format === 'markdown-v1' ? view.content.value : JSON.stringify(view.content.value);
                    const refs = observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId);
                    const markup = buildViewMessageMarkup({ appId: String(app.appId), appName: app.name || String(app.appId),
                        viewId: view.id, viewType: view.type, viewName: view.name, markup: content,
                        suffix: refs.length ? '\n\nAvailable references: ' + refs.map(ref => `${ref.refId} (${ref.refType})`).join(', ') : '' });
                    messages.push({ role: 'user', region: view.kind === 'instruction' ? 'static' : 'dynamic',
                        timestamp: timestamp(JSON.stringify([app.appId, view.viewInstanceId]), markup), content: markup });
                }
            }
            groups.forEach(group => {
                const name = buildPublicToolName(group.app.name || String(group.app.appId), group.tool.viewType, group.tool.name);
                if (bindings.has(name)) throw new Error(`AOTUI_TOOL_NAME_COLLISION: ${JSON.stringify(name)}. ` +
                    'Use distinct application names and unambiguous ViewType/toolName declarations.');
                const schema = group.tool.inputSchema as Record<string, unknown>;
                if (group.targets.size > 1 && !group.selector)
                    throw new Error(`TOOL_TARGET_REQUIRED: ${name} has multiple Views. Declare target: { param, value } using an existing required string parameter.`);
                bindings.set(name, group);
                tools[name] = { description: `${group.tool.description}\nApplication: ${group.app.name || group.app.appId}; Views: ${[...group.targets.values()].map(target => target.viewId).join(', ')}.`,
                    inputSchema: jsonSchema(schema) };
            });
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
                ...(issues.has(String(app.appId)) ? [`    - Semantic status: ${issues.get(String(app.appId))}`] : []),
            ].join('\n')).join('\n') : installedApps.length ? '- No applications enabled for this context.' : '- No applications installed.'}\n\n## System Logs\n${logs.length ? logs.map(log => `- [${formatTimestamp(log.timestamp)}] ${log.message}`).join('\n') : this.disabledApps.size ? '- Desktop-wide logs are hidden while application filtering is active.' : '- No recent activity.'}\n\n</desktop>`;
            messages.push({ role: 'user', region: 'dynamic', content: desktopMarkup,
                timestamp: timestamp('desktop', desktopMarkup) });
            const control = this.controls(apps, tools);
            if (released || this.generation !== generation) { owner.release(); return { messages: [], tools: {} }; }
            this.presentations = presentations;
            return { messages, tools, release: owner.release,
                executeTool: async (name, args, callId) => {
                    if (released || this.disposed || !this.enabled) return name in tools ? unavailable(name, callId, 'SEMANTIC_CONTEXT_RELEASED', 'This observation was released; obtain a new context.') : undefined;
                    const handler = control.get(name);
                    if (handler) return handler(args, callId);
                    const group = bindings.get(name);
                    if (!group) return undefined;
                    if (!this.allowed(group.app)) return unavailable(name, callId, 'APP_DISABLED', 'This application is disabled.');
                    if (!object(args)) return unavailable(name, callId, 'INVOCATION_INVALID', 'Tool input must be an object.');
                    let binding: Binding;
                    if (group.selector) {
                        const fields = Object.getOwnPropertyDescriptors(args);
                        const target = fields[group.selector];
                        if (!target || !('value' in target) || typeof target.value !== 'string' || !group.targets.has(target.value))
                            return unavailable(name, callId, 'INVALID_VIEW_TARGET', `Select ${group.selector} from this Tool's observed Views.`);
                        if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !fields[key].enumerable || !('value' in fields[key])))
                            return unavailable(name, callId, 'INVOCATION_INVALID', 'Tool input must contain ordinary JSON properties.');
                        binding = group.targets.get(target.value)!;
                    } else binding = group.targets.values().next().value!;
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
            tools[name] = { description, inputSchema: jsonSchema({ type: 'object', properties: { app_id: { type: 'string', enum: [...ids] } }, required: ['app_id'], additionalProperties: false }) };
            handlers.set(name, async (input, callId) => {
                if (!object(input) || Object.keys(input).length !== 1 || typeof input.app_id !== 'string' || !ids.has(input.app_id))
                    return unavailable(name, callId, 'INVALID_APP_TARGET', 'Select an application from this observation.');
                const app = this.listApps().find(item => String(item.appId) === input.app_id);
                if (!app || !this.allowed(app) || !(statuses as readonly string[]).includes(app.status))
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
