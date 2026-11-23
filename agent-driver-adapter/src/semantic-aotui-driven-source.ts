import { createHash, randomUUID } from 'node:crypto';
import { jsonSchema, ProviderToolSchemaError, type ProviderToolSchemaPolicy, type Tool } from '@aotui/agent-driver-v2';
import { buildViewMessageMarkup, buildPublicToolName, collapsedWindowText, escapeXmlText,
    DEFAULT_AOTUI_SYSTEM_INSTRUCTION, type WindowPresentation } from '@aotui/runtime/adapters';
import { isInstanceName } from '@aotui/core';
import { loadAOTUIInstruction } from './load-aotui-instruction.js';
import { formatAppStatus, formatTimestamp } from './presentation.js';
import type { ContextDrivenSource, DrivenSourceContext, MessageWithTimestamp, ToolExecutionBudget, ToolResult } from '@aotui/agent-driver-v2';
import type {
    AppID, IDesktop, IKernel, AppDiscoveryInfo, Observation, InvokeResult, AppInteraction, AppInteractionPolicy, AppInvocation,
    AppWindows, ConsoleInputPath, ObservationWindowSelection, ProgramToolInput, ReceiptQuery, RequestSources, ViewWindowTarget,
} from '@aotui/runtime';
import { BUDGET_TOOL, budgetHint, budgetPage, fitModelWindows, type BudgetNotice, type RenderedWindows,
    type WindowBudgetContent, type WindowBudgetReport, type WindowCost } from './window-budget.js';
import { createConsoleTool, RUN_CODE, type ConsoleRoutedCall } from './console/console-tool.js';
import { createNodeScopedConsoleExecutor, type ConsoleExecutor } from './console/node-process.js';

export interface PendingAppReceipt extends ReceiptQuery {
    readonly desktopId: IDesktop['id'];
    readonly appId: AppID;
    readonly appInstanceId: string;
}

export interface SemanticAOTUIDrivenSourceOptions {
    includeInstruction?: boolean;
    instruction?: string;
    instructionPath?: string;
    /** Trusted Host policy; applications and model arguments cannot supply it. */
    policy?: (app: AppDiscoveryInfo) => AppInteractionPolicy;
    /** Delivers the original locator and the execution result it belongs to. */
    onReceiptPending?: (locator: PendingAppReceipt, result: Readonly<ToolResult>, subcallId?: string) => void;
    /** Trusted Host override. The standard executor uses macOS Seatbelt. */
    consoleExecutor?: ConsoleExecutor;
    maxApps?: number;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const desktopToolNames = {
    open: 'system-open_app',
    close: 'system-close_app',
    collapse: 'system-collapse_app',
    expand: 'system-expand_app',
    collapseView: 'system-collapse_view',
    expandView: 'system-expand_view',
    closeView: 'system-close_view',
} as const;
const reservedDesktopToolNames = new Set<string>([...Object.values(desktopToolNames), BUDGET_TOOL, RUN_CODE]);
const unavailable = (toolName: string, toolCallId: string, code: string, message: string, outcomeStatus: 'rejected' | 'unknown' = 'rejected'): ToolResult =>
    ({ toolName, toolCallId, outcomeStatus, error: { code, message } });

/** Keep Core receipts internal while returning Tool result data and actionable errors to the Driver. */
function semanticToolResult(toolName: string, toolCallId: string, result: InvokeResult): ToolResult {
    if (result.kind === 'unavailable' && (result.code === 'INVOCATION_WAIT_TIMEOUT' || result.code === 'INVOCATION_WAIT_CANCELLED')) {
        return unavailable(toolName, toolCallId, result.code,
            (result.code === 'INVOCATION_WAIT_TIMEOUT' ? 'Timed out waiting for the result of the original operation. '
                : 'Cancelled the wait for the result of the original operation. ') + 'It may still be running. ' +
                'Check the current App View for its effects before repeating the operation.', 'unknown');
    }
    if (result.kind !== 'receipt') return unavailable(toolName, toolCallId, result.code, result.message,
        result.kind === 'refused' || result.code === 'INVOCATION_DEADLINE_EXCEEDED' || result.code === 'INVOCATION_CANCELLED' ? 'rejected' : 'unknown');
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
            message: (business?.error?.message ?? outcome.message) +
                (outcome.status === 'rejected' && outcome.path ? ' At ' + outcome.path + '.' : '') },
    };
}

interface ToolRoute { app: AppDiscoveryInfo; client: AppInteraction; observationId: string; toolId: string; programInput?: ProgramToolInput }
interface AppIssue { code: string; message: string; path?: string }
interface CapturedObservation { client: AppInteraction; observation: Observation; released: boolean }
interface AppProjection {
    app: AppDiscoveryInfo;
    captured: CapturedObservation;
    tools: Map<string, Observation['tools'][number]>;
}

interface ContextOwner { observations: readonly CapturedObservation[]; release(): void }
type PresentationEntry = { displayed?: { digest: string; timestamp: number }; bodyBytes?: number; restoreBody?: true };
type Expansion = { appId: AppID; instanceId: string; view?: ViewWindowTarget; bodies: ReadonlySet<string> };
type BudgetReportScope = readonly { installationId: string; appId: AppID; instanceId: string;
    views: ObservationWindowSelection['refViews'] }[];
type StoredReport = { report: WindowBudgetReport; scope: BudgetReportScope; key: string; until: number };
type Control = (input: unknown, callId: string, budget?: ToolExecutionBudget) => Promise<ToolResult>;
const windowKey = (appId: string, viewInstanceId: string) => JSON.stringify([appId, viewInstanceId]);

class AppProjectionError extends Error {
    constructor(readonly code: string, message: string, readonly path?: string) { super(message); }
}

function boundedText(text: string, limit: number): string {
    let safe = '';
    for (const character of text) {
        const escaped = character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;'
            : /[\u0000-\u001f\u007f]/.test(character) ? ' ' : character;
        if (safe.length + escaped.length > limit) break;
        safe += escaped;
    }
    return safe;
}

function boundedIssue(code: string, message: string, path?: string): AppIssue {
    const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'AOTUI_APP_PROJECTION_FAILED';
    return { code: safeCode, message: boundedText(message, 220),
        ...(path === undefined ? {} : { path: boundedText(path, 512) }) };
}

function formatAppIssue(issue: AppIssue): string {
    return `${issue.code}: ${issue.message}${issue.path ? ` (at ${issue.path})` : ''}`;
}

function appIssueFrom(error: unknown): AppIssue {
    if (error instanceof AppProjectionError) return boundedIssue(error.code, error.message, error.path);
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
 * Runtime keeps receipts on the App instance. Releasing a context only releases
 * the observations prepared for that context.
 */
export class SemanticAOTUIDrivenSource implements ContextDrivenSource {
    readonly name = 'AOTUI';
    private enabled = true;
    private appsEnabled = true;
    private disposed = false;
    private closing?: Promise<void>;
    private generation = 0;
    private readonly disabledApps = new Set<string>();
    private readonly policies = new Map<string, { instanceId: string; policy: AppInteractionPolicy }>();
    private readonly contexts = new Set<ContextOwner>();
    private readonly listeners = new Set<() => void>();
    private readonly update = () => { for (const listener of this.listeners) listener(); };
    private subscribed = false;
    private readonly maxApps: number;
    private readonly consoleExecutor: ConsoleExecutor;
    private readonly instruction: string;
    private presentations = new Map<string, PresentationEntry>();
    private presentationTime = 1;
    private readonly reports = new Map<string, StoredReport>();

    constructor(private readonly desktop: IDesktop, private readonly kernel: IKernel,
        private readonly options: SemanticAOTUIDrivenSourceOptions = {}) {
        this.maxApps = options.maxApps ?? 128;
        this.consoleExecutor = options.consoleExecutor ?? createNodeScopedConsoleExecutor();
        this.instruction = loadAOTUIInstruction(options, DEFAULT_AOTUI_SYSTEM_INSTRUCTION);
        if (!Number.isSafeInteger(this.maxApps) || this.maxApps < 1) throw new Error('SEMANTIC_SOURCE_LIMIT_INVALID');
        if (typeof desktop.getInstalledApps !== 'function' || typeof kernel.getAppInteraction !== 'function')
            throw new Error('SEMANTIC_RUNTIME_UNSUPPORTED');
    }

    listApps(): readonly AppDiscoveryInfo[] {
        if (this.disposed) return [];
        const apps = this.desktop.getInstalledApps();
        if (apps.length > this.maxApps) throw new Error('SEMANTIC_APP_CAPACITY');
        // Do not expose launch configuration, paths, credentials, or mutable registry records.
        return apps.map(app => ({ installationId: app.installationId,
            ...(app.appId && app.appInstanceId ? { appId: app.appId, appInstanceId: app.appInstanceId } : {}),
            name: app.name, status: app.status,
            description: app.description, whatItIs: app.whatItIs, whenToUse: app.whenToUse }));
    }

    private currentApp(installationId: string): AppDiscoveryInfo | undefined {
        for (const candidate of this.desktop.getInstalledApps()) {
            let candidateId: string;
            try {
                if (!object(candidate)) continue;
                const descriptor = Object.getOwnPropertyDescriptor(candidate, 'installationId');
                if (!descriptor || !('value' in descriptor)) continue;
                candidateId = String(descriptor.value);
            } catch { continue; }
            if (candidateId !== installationId) continue;
            try {
                const fields = Object.getOwnPropertyDescriptors(candidate);
                const value = (key: string) => {
                    const descriptor = fields[key];
                    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
                };
                const status = value('status');
                if (!['pending', 'running', 'closed', 'collapsed'].includes(status as string)) return undefined;
                const name = value('name'), appId = value('appId');
                if (typeof name !== 'string') return undefined;
                const appInstanceId = value('appInstanceId');
                return { installationId, name, status: status as AppDiscoveryInfo['status'],
                    ...(typeof appId === 'string' && typeof appInstanceId === 'string' ? { appId: appId as AppID, appInstanceId } : {}) };
            } catch { return undefined; }
        }
        return undefined;
    }

    private allowed(app: AppDiscoveryInfo): boolean {
        return this.isAppEnabled(app.installationId);
    }

    isAppEnabled(installationId: string): boolean {
        return this.enabled && this.appsEnabled && !this.disposed && !this.disabledApps.has(installationId);
    }

    private async invokeApp(route: ToolRoute, name: string, args: unknown, id: string, sources?: RequestSources,
        signal?: AbortSignal, program = false): Promise<ConsoleRoutedCall> {
        if (program && signal?.aborted) return { result: unavailable(name, id, 'CONSOLE_CANCELLED', 'Cancelled before dispatch.') };
        if (!this.allowed(route.app)) return { result: unavailable(name, id, 'APP_DISABLED', 'This application is disabled.') };
        if (!object(args)) return { result: unavailable(name, id, 'INVOCATION_INVALID', 'Tool input must be an object.') };
        const pending = (): PendingAppReceipt | undefined => {
            const { appId, appInstanceId } = route.app;
            if (appId && appInstanceId) return Object.freeze({ desktopId: this.desktop.id, appId, appInstanceId,
                observationId: route.observationId, invocationId: id });
        };
        try {
            const request: AppInvocation = { invocationId: id, observationId: route.observationId, toolId: route.toolId,
                input: args as AppInvocation['input'], ...(program ? { inputMode: 'program' } : {}) };
            const invoked = signal ? await route.client.invoke(request, undefined, sources, signal)
                : await route.client.invoke(request, undefined, sources);
            return { result: semanticToolResult(name, id, invoked),
                ...(invoked.kind === 'receipt' ? { receipt: invoked.receipt } : {}),
                ...(invoked.kind === 'unavailable' && (invoked.code === 'INVOCATION_WAIT_TIMEOUT' || invoked.code === 'INVOCATION_WAIT_CANCELLED')
                    ? { pending: pending() } : {}) };
        } catch {
            return { result: unavailable(name, id, 'INVOCATION_RESULT_UNKNOWN', 'Execution could not be confirmed. Do not blindly retry.', 'unknown'),
                pending: pending() };
        }
    }

    private reportPendingReceipt(locator: PendingAppReceipt, result: ToolResult, subcallId?: string): void {
        if (this.disposed) return;
        try { this.options.onReceiptPending?.(locator, result, subcallId); }
        catch { /* Host bookkeeping cannot change the operation outcome. */ }
    }

    private appInteraction(app: AppDiscoveryInfo): AppInteraction {
        const { appId, appInstanceId: instanceId } = app;
        if (!appId || !instanceId) throw new AppProjectionError('APP_INTERACTION_UNAVAILABLE', 'No running App instance to observe.');
        let policy = this.policies.get(appId);
        if (this.options.policy && policy?.instanceId !== instanceId) {
            policy = { instanceId, policy: this.options.policy(app) };
            this.policies.set(appId, policy);
        }
        const access = this.kernel.getAppInteraction(this.desktop.id, appId, instanceId, policy?.policy);
        if (access.status === 'rejected') throw new AppProjectionError(access.issue.code, access.issue.message, access.issue.path);
        return access.interaction;
    }

    getContext(toolSchema?: ProviderToolSchemaPolicy): Promise<DrivenSourceContext> { return this.prepareContext(toolSchema); }

    private async prepareContext(toolSchema?: ProviderToolSchemaPolicy, expansion?: Expansion): Promise<DrivenSourceContext> {
        if (this.disposed || !this.enabled) return { messages: [], tools: {} };
        if (this.contexts.size >= 2) throw new Error('SEMANTIC_CONTEXT_CAPACITY');
        const generation = this.generation;
        const observations: CapturedObservation[] = [];
        const consoleLifetime = new AbortController();
        let released = false;
        let adopted: DrivenSourceContext | undefined;
        let requestSources: RequestSources | undefined;
        const owner: ContextOwner = { observations, release: () => {
            if (released) return;
            released = true;
            consoleLifetime.abort();
            requestSources = undefined;
            for (const observed of observations) releaseCaptured(observed);
            observations.length = 0;
            this.contexts.delete(owner);
        } };
        this.contexts.add(owner);
        try {
            const appsEnabled = this.appsEnabled;
            const installedApps = appsEnabled ? this.listApps() : [];
            const apps = installedApps.filter(app => this.allowed(app));
            const installedIds = new Set<string | undefined>(installedApps.map(app => app.appId));
            for (const id of this.policies.keys()) if (!installedIds.has(id)) this.policies.delete(id);
            const previous = this.presentations;
            const presentationTime = Math.max(Date.now(), this.presentationTime);
            const issues = new Map<string, AppIssue>();
            const projections: AppProjection[] = [];
            for (const app of apps) {
                const { appId, name: appName, installationId } = app;
                if (!appId || (app.status !== 'running' && !(app.status === 'collapsed' && expansion?.appId === appId))) continue;
                let interaction: AppInteraction | undefined;
                let observation: Observation | undefined;
                try {
                    if (!isInstanceName(appName) || !isInstanceName(appId))
                        throw new AppProjectionError('AOTUI_APP_IDENTITY_INVALID',
                            'App names and IDs use ASCII letters, digits and underscores and must include a nondigit.');
                    interaction = this.appInteraction(app);
                    const observed = await interaction.observe({ all: true, programTools: true });
                    if (observed.status !== 'observed') {
                        const { code, message, path } = observed.issue;
                        throw new AppProjectionError(code, message, path);
                    }
                    observation = observed.observation;
                    if (released || this.generation !== generation) {
                        interaction.releaseObservation(observation.observationId);
                        continue;
                    }

                    const localTools: AppProjection['tools'] = new Map();
                    for (const tool of observation.tools) {
                        if (typeof tool.nameSharedAcrossViewTypes !== 'boolean') {
                            throw new AppProjectionError('AOTUI_TOOL_NAME_METADATA_REQUIRED',
                                'The Runtime did not supply the registered Tool name information. Use matching Runtime and Adapter builds.');
                        }
                        const qualify = tool.nameSharedAcrossViewTypes || reservedDesktopToolNames.has(`${appId}-${tool.name}`);
                        const name = qualify ? buildPublicToolName(appId, tool.viewType, tool.name) : buildPublicToolName(appId, tool.name);
                        if (localTools.has(name)) throw new AppProjectionError('AOTUI_TOOL_NAME_COLLISION',
                            `Public Tool alias ${JSON.stringify(name)} is declared more than once by this App. Rename its ViewType or Tool.`);
                        if (!object(tool.inputSchema)) throw new AppProjectionError('AOTUI_TOOL_SCHEMA_INVALID',
                            'This App Tool has an invalid input schema. Declare a JSON Schema object and refresh the context.');
                        localTools.set(name, tool);
                    }
                    const captured: CapturedObservation = { client: interaction, observation, released: false };
                    if (!observation.views.length && !localTools.size) {
                        releaseCaptured(captured);
                        continue;
                    }
                    observations.push(captured);
                    projections.push({ app, captured, tools: localTools });
                } catch (error) {
                    if (observation && interaction) interaction.releaseObservation(observation.observationId);
                    issues.set(installationId, appIssueFrom(error));
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
                    issues.set(projection.app.installationId, boundedIssue('AOTUI_TOOL_NAME_COLLISION',
                        `Public Tool alias ${JSON.stringify(conflict)} collides with another App. Rename this App, ViewType, or Tool.`));
                    releaseCaptured(projection.captured);
                    continue;
                }
                accepted.add(projection);
                for (const name of projection.tools.keys()) nameOwners.set(name, String(projection.app.appId));
            }
            const catalog = new Map<string, AppWindows>();
            for (const app of apps) {
                if (!app.appId || !app.appInstanceId) continue;
                const windows = this.desktop.getAppWindows(app.appId, app.appInstanceId);
                if (windows) catalog.set(app.appId, windows);
            }
            const displayCatalog = expansion ? new Map(catalog) : catalog;
            if (expansion) {
                const expanding = apps.find(app => app.appId === expansion.appId && app.appInstanceId === expansion.instanceId);
                const projection = [...accepted].find(item => item.app === expanding);
                const mount = expansion.view?.viewInstanceId;
                const window = catalog.get(expansion.appId);
                const required = mount === undefined ? window?.views : window?.views.filter(view => view.viewInstanceId === mount);
                if (!expanding || !window || issues.has(expanding.installationId) || (mount !== undefined && !required?.length) ||
                    required?.some(view => !projection?.captured.observation.views.some(observed =>
                        observed.id === view.viewId && observed.viewInstanceId === view.viewInstanceId)))
                    throw new AppProjectionError('WINDOW_EXPANSION_UNAVAILABLE', 'The expanded Window could not be observed.');
                const { note: _appNote, ...openApp } = window;
                displayCatalog.set(expansion.appId, mount === undefined ? openApp : { ...window,
                    views: window.views.map(view => {
                        if (view.viewInstanceId !== mount) return view;
                        const { note: _note, ...open } = view;
                        return open;
                    }) });
            }
            const displayApp = (app: AppDiscoveryInfo) => expansion && expansion.appId === app.appId && expansion.instanceId === app.appInstanceId &&
                !expansion.view ? { ...app, status: 'running' as const } : app;
            const displayed = apps.map(displayApp);
            const viewNotes = new Map<string, string>();
            for (const app of displayCatalog.values()) for (const view of app.views) {
                if (view.note !== undefined) viewNotes.set(windowKey(app.appId, view.viewInstanceId), view.note);
            }
            let logs: readonly { timestamp: number; message: string }[] = [];
            if (appsEnabled && !this.disabledApps.size) {
                try { logs = this.desktop.getSystemLogs?.().slice(-5) ?? []; } catch { /* Optional diagnostic metadata. */ }
            }
            const scope: BudgetReportScope = displayed.flatMap(app => !app.appId || !app.appInstanceId ? [] : [{
                installationId: app.installationId, appId: app.appId, instanceId: app.appInstanceId,
                views: app.status === 'running' ? (catalog.get(app.appId)?.views ?? []).map(({ viewId, viewInstanceId }) =>
                    ({ viewId, viewInstanceId })) : [],
            }]);
            for (const [id, stored] of this.reports) if (!this.budgetReportReadable(stored)) this.reports.delete(id);
            const hasReports = this.reports.size > 0;
            const locate = (report: WindowBudgetContent) => this.locateBudgetReport(report, scope, generation);
            const render = ({ hints, managementOnly }: WindowPresentation, notice?: BudgetNotice, includeReportTool = false): RenderedWindows => {
                const messages: MessageWithTimestamp[] = [];
                const tools: Record<string, Tool> = {};
                const routes = new Map<string, ToolRoute>();
                const consolePaths: ConsoleInputPath[] = [];
                const windows: WindowCost[] = [];
                const presentations = new Map<string, PresentationEntry>();
                const selections = new Map<string, ObservationWindowSelection>();
                const presentedByApp = new Map<string, Pick<Observation, 'source' | 'views'>>();
                const renderIssues = new Map(issues);
                let nextTimestamp = presentationTime;
                const timestamp = (id: string, content: string, bodyBytes?: number) => {
                    const digest = createHash('sha256').update(content).digest('hex');
                    const prior = previous.get(id)?.displayed;
                    const displayed = { digest, timestamp: prior?.digest === digest ? prior.timestamp : ++nextTimestamp };
                    presentations.set(id, { displayed, ...(bodyBytes === undefined ? {} : { bodyBytes }) });
                    return displayed.timestamp;
                };
                if (appsEnabled && this.options.includeInstruction !== false && !managementOnly)
                    messages.push({ role: 'user', content: this.instruction, timestamp: 1, region: 'static' });
                for (const projection of projections) {
                    if (!accepted.has(projection)) continue;
                    const { captured: { client, observation }, app, tools: declared } = projection;
                    const { source } = observation;
                    const appExpanded = displayApp(app).status === 'running';
                    const views = managementOnly || !appExpanded ? [] : observation.views.filter(view => !viewNotes.has(windowKey(source.appId, view.viewInstanceId)));
                    const live = [...declared].filter(([, tool]) => views.some(view =>
                        view.type === tool.viewType && (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id))));
                    for (const [name, tool] of live) {
                        const issue = toolSchema?.check?.(tool.inputSchema);
                        if (!issue) continue;
                        const failure = new ProviderToolSchemaError(toolSchema!.label, name, issue.path, issue.reason);
                        if (expansion?.appId === source.appId) throw failure;
                        renderIssues.set(app.installationId, boundedIssue(failure.code,
                            `${failure.provider} cannot encode ${name}. ${issue.reason}`, issue.path));
                        break;
                    }
                    if (renderIssues.has(app.installationId)) continue;
                    const receiverViews = views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
                    const refViews = receiverViews.filter(view => !hints.has(windowKey(source.appId, view.viewInstanceId)));
                    selections.set(source.appId, { receiverViews, refViews });
                    presentedByApp.set(source.appId, { source, views });
                    for (const [name, tool] of live) {
                        tools[name] = { description: `${tool.description}\nApp ID ${source.appId}, view_type ${tool.viewType} (${tool.multiplicity}).`,
                            inputSchema: jsonSchema(tool.inputSchema) };
                        routes.set(name, { app, client, observationId: observation.observationId,
                            toolId: tool.id, programInput: tool.programInput });
                    }
                }
                for (const projection of projections) {
                    const { observation } = projection.captured;
                    const appId = observation.source.appId;
                    const selected = selections.get(appId);
                    if (!selected || managementOnly || displayApp(projection.app).status === 'collapsed') continue;
                    const bodies = new Set(selected.refViews.map(view => view.viewInstanceId));
                    for (const view of observation.views) {
                        const key = windowKey(appId, view.viewInstanceId);
                        const note = viewNotes.get(key);
                        const body = bodies.has(view.viewInstanceId);
                        const refs = body ? observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId) : [];
                        for (const ref of refs) for (const path of ref.programPaths ?? []) {
                            consolePaths.push({ appId, viewId: ref.viewId, refId: ref.refId, ...path });
                        }
                        const markup = buildViewMessageMarkup({ appId, appName: projection.app.name, viewId: view.id, viewType: view.type,
                            markup: note !== undefined ? collapsedWindowText(note) : body ? view.content.value
                                : budgetHint(Buffer.byteLength(view.content.value, 'utf8'), notice!.full), refs }, presentedByApp);
                        const bytes = Buffer.byteLength(markup, 'utf8');
                        windows.push({ key, app_id: appId, view_id: view.id,
                            presentation: note !== undefined ? 'note' : body ? 'body' : 'hint', bytes });
                        messages.push({ role: 'user', region: view.region,
                            timestamp: timestamp(key, view.region + '\0' + markup, body ? bytes : undefined), content: markup });
                    }
                }
                if (appsEnabled) {
                    const entries = displayed.map((app, index) => {
                        const window = app.appId ? displayCatalog.get(app.appId) : undefined;
                        const note = app.status === 'collapsed' ? window?.note : undefined;
                        const noteMarkup = note !== undefined && !managementOnly ? escapeXmlText(collapsedWindowText(note)) : undefined;
                        if (app.appId && noteMarkup) windows.push({ key: 'app:' + app.appInstanceId, app_id: app.appId,
                            presentation: 'note', bytes: Buffer.byteLength(noteMarkup, 'utf8') });
                        return [
                            `${index + 1}. ${app.name}`, `    - installation_id: ${app.installationId}`, ...(app.appId ? [`    - app_id: ${app.appId}`] : []),
                            `    - Status: ${formatAppStatus(app.status)}`, ...(noteMarkup ? ['    - ' + noteMarkup] : []),
                            ...(!managementOnly ? [`    - What it is: ${app.whatItIs || app.description || 'Not provided'}`,
                                `    - When to use: ${app.whenToUse || 'Not provided'}`] : []),
                            ...(renderIssues.has(app.installationId) ? [`    - Semantic status: ${formatAppIssue(renderIssues.get(app.installationId)!)}`] : []),
                            ...(app.status === 'running' ? (window?.views ?? []).map(view => {
                                const collapsed = view.note !== undefined;
                                return `    - view_id: ${view.viewId} [${collapsed ? 'collapsed; expand' : 'open; collapse'}${view.canClose ? ', close' : ''}]`;
                            }) : []),
                        ].join('\n');
                    });
                    const activity = managementOnly ? '' : '\n\n## System Logs\n' + (logs.length
                        ? logs.map(log => `- [${formatTimestamp(log.timestamp)}] ${log.message}`).join('\n')
                        : this.disabledApps.size ? '- Desktop-wide logs are hidden while application filtering is active.' : '- No recent activity.');
                    const budgetText = notice ? `\n\nContext budget: ${notice.full.estimated} estimated; ${notice.full.inputLimit} available. ` +
                        `Use the window controls or ${BUDGET_TOOL} with report_id ${notice.reportId}.\n` : '';
                    const desktopMarkup = '<desktop>\n\n## Installed TUI Applications\n' +
                        (entries.length ? entries.join('\n') : installedApps.length ? '- No applications enabled for this context.' : '- No applications installed.') +
                        activity + budgetText + '\n\n</desktop>';
                    messages.push({ role: 'user', region: 'dynamic', content: desktopMarkup, timestamp: timestamp('desktop', desktopMarkup) });
                }
                const control = appsEnabled ? this.controls(displayed, displayCatalog, tools,
                    hasReports || !!notice || includeReportTool, toolSchema) : undefined;
                let consoleTool = managementOnly ? undefined : createConsoleTool(
                    [...routes].flatMap(([name, route]) => route.programInput ? [{ name, input: route.programInput }] : []),
                    consolePaths, this.consoleExecutor, toolSchema?.strict === true);
                if (consoleTool) {
                    const issue = toolSchema?.check?.(consoleTool.schema);
                    if (issue) {
                        const content = formatAppIssue(boundedIssue('MODEL_TOOL_SCHEMA_UNSUPPORTED',
                            `Optional tool ${RUN_CODE} is unavailable in ${toolSchema!.label}. ${issue.reason}` +
                            (toolSchema?.strict ? ' Use non-strict mode to enable run_code.' : ''), issue.path));
                        messages.push({ role: 'user', region: 'dynamic', content, timestamp: timestamp('console-availability', content) });
                        consoleTool = undefined;
                    } else tools[RUN_CODE] = consoleTool.tool;
                }
                const toolsSettlingOnAbort = new Set(routes.keys());
                if (consoleTool && this.consoleExecutor.settlesOnAbort) toolsSettlingOnAbort.add(RUN_CODE);
                const context: DrivenSourceContext = {
                    messages, tools, release: owner.release, preserveTools: true, toolsSettlingOnAbort,
                    ...(managementOnly ? { managementOnly: true } : {}),
                    ...(appsEnabled ? { fitModelBudget: (measure, withFeedback) =>
                        fitModelWindows(full, render, previous, measure, withFeedback, locate, expansion?.bodies) } : {}),
                    adopt: () => {
                        if (released || this.disposed || !this.enabled || this.generation !== generation || expansion)
                            throw Object.assign(new Error('This prepared context is no longer available.'), { code: 'SEMANTIC_CONTEXT_RELEASED' });
                        if (adopted === context) return;
                        if (adopted) throw Object.assign(new Error('Prepare a fresh observation to change its presentation.'), { code: 'SEMANTIC_CONTEXT_ADOPTED' });
                        for (const [appId, expected] of catalog) {
                            const current = this.desktop.getAppWindows(appId as AppID, expected.instanceId);
                            if (JSON.stringify(current) !== JSON.stringify(expected))
                                throw Object.assign(new Error('A Window changed while preparing the model request.'), { code: 'SEMANTIC_WINDOW_CHANGED' });
                        }
                        const selected = observations.filter(item => {
                            if (!selections.has(item.observation.source.appId)) releaseCaptured(item);
                            return !item.released;
                        });
                        const results = selected.map(item => {
                            const { observation } = item;
                            const appId = observation.source.appId;
                            const layout = selections.get(appId)!;
                            try {
                                const all = layout.receiverViews.length === observation.views.length && layout.refViews.length === observation.views.length;
                                const result = all ? item.client.adoptObservation(observation.observationId)
                                    : item.client.adoptObservation(observation.observationId, layout);
                                return Object.freeze({ appId, ...result });
                            } catch {
                                return Object.freeze({ appId, status: 'rejected' as const,
                                    issue: { code: 'OBSERVATION_ADOPTION_FAILED', message: 'App observation adoption failed.' } });
                            }
                        });
                        const succeeded = results.some(result => result.status === 'adopted');
                        const failed = results.some(result => result.status === 'rejected');
                        // A partial handover cannot restore already revoked qualifications.
                        if (!failed || succeeded) for (const prior of this.contexts) if (prior !== owner) prior.release();
                        if (failed) {
                            owner.release();
                            throw Object.assign(new Error('The prepared context could not be adopted.'), {
                                code: succeeded ? 'SEMANTIC_ADOPTION_PARTIAL' : 'SEMANTIC_ADOPTION_FAILED', results: Object.freeze(results),
                            });
                        }
                        try {
                            const bound = selected.filter(item => {
                                const layout = selections.get(item.observation.source.appId)!;
                                return layout.receiverViews.length || layout.refViews.length;
                            });
                            if (bound.length) requestSources = this.desktop.bindRequestSources({ apps: bound.map(item => ({
                                client: item.client, observationId: item.observation.observationId,
                            })) });
                            if (released || this.generation !== generation) throw new Error('The App selection changed during adoption.');
                        } catch (cause) {
                            owner.release();
                            throw Object.assign(new Error('The adopted App observations could not be bound to this request.', { cause }),
                                { code: 'SEMANTIC_BINDING_FAILED' });
                        }
                        this.presentations = presentations;
                        this.presentationTime = nextTimestamp;
                        adopted = context;
                    },
                    executeTool: async (name, args, callId, budget, signal) => {
                        if (released || this.disposed || !this.enabled) return name in tools ? unavailable(name, callId, 'SEMANTIC_CONTEXT_RELEASED', 'This observation was released; obtain a new context.') : undefined;
                        if (adopted !== context) return name in tools ? unavailable(name, callId, 'SEMANTIC_CONTEXT_NOT_ADOPTED', 'Adopt this prepared context before invoking its tools.') : undefined;
                        if (name === RUN_CODE && consoleTool) {
                            const sources = requestSources ?? this.desktop.bindRequestSources({ apps: [] });
                            const cancellation = signal ? AbortSignal.any([signal, consoleLifetime.signal]) : consoleLifetime.signal;
                            return consoleTool.execute(args, callId, sources, cancellation, async (name, input, childId, childSignal) => {
                                const route = routes.get(name);
                                return route ? this.invokeApp(route, name, input, childId, sources, childSignal, true)
                                    : { result: unavailable(name, childId, 'TOOL_UNAVAILABLE', 'This Tool was not published in the original request.') };
                            }, (locator, result) => this.reportPendingReceipt(locator, result, locator.invocationId));
                        }
                        const handler = control?.get(name);
                        if (handler) return handler(args, callId, budget);
                        const route = routes.get(name);
                        if (!route) return undefined;
                        const called = await this.invokeApp(route, name, args, callId, requestSources, signal);
                        if (called.pending) this.reportPendingReceipt(called.pending, called.result);
                        return called.result;
                    },
                };
                return { context, windows };
            };
            if (released || this.generation !== generation) { owner.release(); return { messages: [], tools: {} }; }
            const full = render({ hints: new Set(), managementOnly: false });
            return full.context;
        } catch (error) { owner.release(); throw error; }
    }

    private budgetScopeCurrent(scope: BudgetReportScope): boolean {
        if (this.disposed || !this.enabled || !this.appsEnabled) return false;
        try {
            return scope.every(app => {
                if (!this.isAppEnabled(app.installationId)) return false;
                const current = this.desktop.getAppWindows(app.appId, app.instanceId);
                return current?.instanceId === app.instanceId && app.views.every(expected => current.views.some(view =>
                    view.viewId === expected.viewId && view.viewInstanceId === expected.viewInstanceId));
            });
        } catch { return false; }
    }

    private budgetReportReadable(stored: StoredReport): boolean {
        return stored.until > Date.now() && this.budgetScopeCurrent(stored.scope);
    }

    private locateBudgetReport(content: WindowBudgetContent, scope: BudgetReportScope, generation: number) {
        const key = JSON.stringify([scope, content]);
        let stored = [...this.reports.values()].find(report => report.key === key && this.budgetReportReadable(report));
        const id = stored?.report.id ?? randomUUID();
        const check = () => {
            if (this.generation !== generation || (stored ? this.reports.get(id) !== stored || !this.budgetReportReadable(stored)
                : !this.budgetScopeCurrent(scope)))
                throw Object.assign(new Error('The window budget report scope changed while preparing the request.'),
                    { code: 'WINDOW_BUDGET_REPORT_UNAVAILABLE' });
        };
        const retain = () => {
            check();
            if (stored) return;
            stored = { report: { id, ...content }, scope, key, until: Date.now() + 5 * 60_000 };
            this.reports.set(id, stored);
            while (this.reports.size > 8) this.reports.delete(this.reports.keys().next().value!);
        };
        return { id, check, retain };
    }

    private async checkExpansion(expansion: Expansion, budget: ToolExecutionBudget, result: ToolResult,
        toolSchema?: ProviderToolSchemaPolicy): Promise<ToolResult | undefined> {
        const trial = await this.prepareContext(toolSchema, expansion);
        try {
            const cost = await budget.checkExpansion(trial, result);
            if (cost.estimated <= cost.inputLimit) return;
            return { ...unavailable(result.toolName, result.toolCallId, 'WINDOW_EXPANSION_BUDGET_EXCEEDED',
                `The expanded request needs about ${cost.estimated} tokens and ${cost.inputLimit} are available. The window remains collapsed.`),
                result: cost };
        } finally { await trial.release?.(); }
    }

    private controls(apps: readonly AppDiscoveryInfo[], catalog: ReadonlyMap<string, AppWindows>,
        tools: Record<string, Tool>, includeReportTool: boolean, toolSchema?: ProviderToolSchemaPolicy): Map<string, Control> {
        const handlers = new Map<string, Control>();
        const operations = new Map<string, { target: string; result: Promise<ToolResult> }>();
        const addRequiredTool = (name: string, description: string, schema: Parameters<typeof jsonSchema>[0]) => {
            const issue = toolSchema?.check?.(schema);
            if (issue) throw new ProviderToolSchemaError(toolSchema!.label, name, issue.path, issue.reason);
            tools[name] = { description, inputSchema: jsonSchema(schema) };
        };
        const actions = [
            { action: 'open', statuses: ['pending', 'closed'], description: 'Start an application using its installation_id from the Desktop.' },
            { action: 'close', statuses: ['running', 'collapsed'], description: 'Close the current application selected by app_id.' },
            { action: 'collapse', statuses: ['running'], description: 'Collapse an application. Keep an optional note in its place.' },
            { action: 'expand', statuses: ['collapsed'], description: 'Expand a collapsed application when the model budget allows it.' },
            { action: 'collapseView', statuses: ['running'], description: 'Collapse an open View and optionally leave a note.' },
            { action: 'expandView', statuses: ['running'], description: 'Expand a collapsed View when the model budget allows it.' },
            { action: 'closeView', statuses: ['running'], description: 'Ask an independently closable View to close, including when collapsed.' },
        ] as const;
        for (const { action, statuses, description } of actions) {
            const opening = action === 'open';
            const isView = action === 'collapseView' || action === 'expandView' || action === 'closeView';
            const notes = action === 'collapse' || action === 'collapseView';
            const expanding = action === 'expand' || action === 'expandView';
            const fieldName = opening ? 'installation_id' : 'app_id';
            const required = isView ? [fieldName, 'view_id'] : [fieldName];
            if (notes && toolSchema?.strict) required.push('note');
            const allowsStatus = (app: AppDiscoveryInfo) => (statuses as readonly string[]).includes(app.status);
            const targets = new Map(apps.filter(allowsStatus).flatMap(app => {
                const id = opening ? app.installationId : app.appId && app.appInstanceId ? app.appId : undefined;
                return id ? [[id, app] as const] : [];
            }));
            if (!opening && action !== 'close' && (!targets.size || (isView && ![...targets.keys()].some(id =>
                catalog.get(id)?.views.some(view => action === 'closeView' || (view.note !== undefined) === expanding))))) continue;
            const name = desktopToolNames[action];
            addRequiredTool(name, description, { type: 'object', properties: {
                [fieldName]: { type: 'string' }, ...(isView ? { view_id: { type: 'string' } } : {}),
                ...(notes ? { note: { type: 'string', description: 'Note to show in place of the content. Use an empty string for no note.' } } : {}),
            }, required, additionalProperties: false });
            handlers.set(name, async (input, callId, budget) => {
                const fields = object(input) ? Object.getOwnPropertyDescriptors(input) : undefined;
                const value = (key: string): string | undefined => {
                    const field = fields?.[key];
                    return field?.enumerable && 'value' in field && typeof field.value === 'string' ? field.value : undefined;
                };
                const target = value(fieldName);
                const viewId = value('view_id');
                const note = value('note');
                const captured = target && targets.get(target);
                if (!fields || !captured || required.some(key => value(key) === undefined) || Reflect.ownKeys(fields).some(key => typeof key !== 'string' ||
                    (!required.includes(key) && !(notes && key === 'note')) || value(key) === undefined))
                    return unavailable(name, callId, 'INVALID_APP_TARGET', 'Supply ' + required.join(', ') + ' using IDs from the current Desktop.');
                if (!this.allowed(captured)) return unavailable(name, callId, 'APP_DISABLED', 'This application is disabled.');
                const identity = JSON.stringify([name, target, viewId]);
                const earlier = operations.get(callId);
                if (earlier) return earlier.target === identity ? earlier.result
                    : unavailable(name, callId, 'INVOCATION_ID_CONFLICT', 'This call ID already belongs to another window operation.');
                const app = this.currentApp(captured.installationId);
                if (!app || !allowsStatus(app))
                    return unavailable(name, callId, 'APP_STATE_CHANGED', 'The application state changed; refresh the context.');
                if (!opening && (!app.appId || app.appId !== captured.appId || app.appInstanceId !== captured.appInstanceId))
                    return unavailable(name, callId, 'APP_INSTANCE_CHANGED', 'The application instance changed; refresh the context.');

                const capturedView = isView && captured.appId ? catalog.get(captured.appId)?.views.find(view => view.viewId === viewId) : undefined;
                if (isView && !capturedView)
                    return unavailable(name, callId, 'INVALID_VIEW_TARGET', 'Select a view_id from the current Desktop.');
                const window = capturedView && app.appId && app.appInstanceId ? {
                    appId: app.appId, instanceId: app.appInstanceId, viewId: capturedView.viewId, viewInstanceId: capturedView.viewInstanceId,
                } : undefined;
                const liveCatalog = app.appId && app.appInstanceId ? this.desktop.getAppWindows(app.appId, app.appInstanceId) : undefined;
                if (window) {
                    const live = liveCatalog?.views.find(view => view.viewId === window.viewId && view.viewInstanceId === window.viewInstanceId);
                    if (!live) return unavailable(name, callId, 'VIEW_INSTANCE_REVOKED', 'The selected View closed or was replaced.');
                    if (action === 'closeView' && (!capturedView!.canClose || !live.canClose))
                        return unavailable(name, callId, 'VIEW_CLOSE_UNAVAILABLE', 'This View has no independent close action. Collapse the View or close its App.');
                    if (action !== 'closeView' && ((live.note !== undefined) !== expanding || (capturedView!.note !== undefined) !== expanding))
                        return unavailable(name, callId, 'VIEW_STATE_CHANGED', 'The window state changed; refresh the context.');
                }

                const apply = async (): Promise<ToolResult> => {
                    try {
                        const appId = opening ? await this.desktop.openApp(app.installationId) : app.appId!;
                        const success: ToolResult = { toolName: name, toolCallId: callId, outcomeStatus: 'succeeded',
                            result: { success: true, app_id: appId, ...(window ? { view_id: window.viewId } : {}) } };
                        const bodies = new Set<string>();
                        if (expanding && budget && app.appInstanceId) {
                            const generation = this.generation;
                            for (const view of window ? [window] : liveCatalog?.views.filter(view => view.note === undefined) ?? [])
                                bodies.add(windowKey(appId, view.viewInstanceId));
                            const issue = await this.checkExpansion({ appId, instanceId: app.appInstanceId, bodies,
                                ...(window ? { view: window } : {}) }, budget, success, toolSchema);
                            if (issue) return issue;
                            if (this.generation !== generation || !this.allowed(captured) ||
                                JSON.stringify(liveCatalog) !== JSON.stringify(this.desktop.getAppWindows(appId, app.appInstanceId)))
                                return unavailable(name, callId, 'VIEW_STATE_CHANGED', 'The window changed during budget preflight. Observe the current Desktop.');
                        }
                        switch (action) {
                            case 'close': await this.desktop.closeApp(appId, captured.appInstanceId); break;
                            case 'collapse': await this.desktop.collapseApp(appId, captured.appInstanceId, note ?? ''); break;
                            case 'expand': await this.desktop.expandApp(appId, captured.appInstanceId); break;
                            case 'collapseView': await this.desktop.collapseView(window!, note ?? ''); break;
                            case 'expandView': await this.desktop.expandView(window!); break;
                            case 'closeView': {
                                const closed = await this.desktop.closeView(window!);
                                this.update();
                                if ('issue' in closed) return { ...unavailable(name, callId, closed.issue.code, closed.issue.message,
                                    closed.status === 'unknown' ? 'unknown' : 'rejected'),
                                    ...(closed.status === 'rejected' && closed.result?.data ? { result: closed.result.data } : {}) };
                                const result = { ...closed.result.data, success: true, view_id: window!.viewId, closed: closed.status === 'closed' };
                                return closed.status === 'closed' ? { ...success, result } : { ...success, outcomeStatus: 'accepted', result,
                                    error: { code: 'VIEW_CLOSE_ACCEPTED', message: 'The App accepted the close; removal of this mount is still unconfirmed.' } };
                            }
                        }
                        if (bodies.size) {
                            const next = new Map(this.presentations);
                            for (const key of bodies) next.set(key, { ...next.get(key), restoreBody: true });
                            this.presentations = next;
                        }
                        this.update();
                        return success;
                    } catch (error) {
                        const code = object(error) && typeof error.code === 'string' ? error.code : '';
                        if (code === 'APP_INSTANCE_CHANGED' || code === 'VIEW_INSTANCE_REVOKED')
                            return unavailable(name, callId, code, 'The selected window was replaced. Refresh the Desktop.');
                        if (expanding && budget && error instanceof ProviderToolSchemaError)
                            return unavailable(name, callId, error.code, error.message + ' The window remains collapsed.');
                        if (expanding && budget)
                            return unavailable(name, callId, code || 'WINDOW_EXPANSION_UNAVAILABLE', 'The expanded request could not be prepared.');
                        return unavailable(name, callId, 'APP_LIFECYCLE_UNKNOWN', 'Window lifecycle completion could not be confirmed.', 'unknown');
                    }
                };
                if (opening && operations.size >= this.maxApps)
                    return unavailable(name, callId, 'APP_LIFECYCLE_CAPACITY', 'Prepare a new observation to start another application.');
                const result = apply();
                if (opening || action === 'closeView') operations.set(callId, { target: identity, result });
                return result;
            });
        }
        if (includeReportTool) {
            addRequiredTool(BUDGET_TOOL, 'Read one page of the window budget report for this conversation.', {
                type: 'object', properties: { report_id: { type: 'string' }, page: { type: 'integer', minimum: 1 } },
                required: ['report_id', 'page'], additionalProperties: false,
            });
            handlers.set(BUDGET_TOOL, async (args, callId) => {
                const report = object(args) && typeof args.report_id === 'string' ? this.reports.get(args.report_id) : undefined;
                const page = object(args) ? args.page : undefined;
                if (!report || !this.budgetReportReadable(report) || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1)
                    return unavailable(BUDGET_TOOL, callId, 'WINDOW_BUDGET_REPORT_UNAVAILABLE', 'Use the report and page from this conversation.');
                const result = budgetPage(report.report, page);
                if (page > 1 && !result.windows?.length)
                    return unavailable(BUDGET_TOOL, callId, 'WINDOW_BUDGET_REPORT_UNAVAILABLE', 'This report has no such page.');
                return { toolName: BUDGET_TOOL, toolCallId: callId, outcomeStatus: 'succeeded', result };
            });
        }
        return handlers;
    }

    setEnabled(enabled: boolean): void {
        if (this.disposed || this.enabled === enabled) return;
        this.enabled = enabled;
        this.invalidateContexts();
    }
    /** Enable App presentation and routing while keeping the system Console available. */
    setAppsEnabled(enabled: boolean): void {
        if (this.disposed || this.appsEnabled === enabled) return;
        this.appsEnabled = enabled;
        this.invalidateContexts();
    }
    private invalidateContexts(): void {
        this.generation++;
        this.presentations.clear();
        this.reports.clear();
        for (const owner of this.contexts) owner.release();
        this.update();
    }
    setAppEnabled(installationId: string, enabled: boolean): void {
        if (this.disposed || !installationId) return;
        if (enabled) this.disabledApps.delete(installationId); else this.disabledApps.add(installationId);
        this.generation++;
        this.reports.clear();
        if (!enabled && this.appsEnabled) {
            const disabled = new Set(this.listApps().filter(app => !this.allowed(app)).map(app => String(app.appId)));
            for (const owner of this.contexts) for (const captured of owner.observations)
                if (disabled.has(captured.observation.source.appId)) releaseCaptured(captured);
        }
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
    dispose(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = Promise.resolve().then(() => this.consoleExecutor.dispose?.());
        this.disposed = true; this.generation++; this.presentations.clear();
        for (const owner of this.contexts) owner.release();
        this.policies.clear();
        this.reports.clear();
        if (this.subscribed) this.desktop.output.unsubscribe(this.update);
        this.subscribed = false; this.listeners.clear();
        return this.closing;
    }
}
