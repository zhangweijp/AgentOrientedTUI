import { createHash, randomUUID } from 'node:crypto';
import { jsonSchema, ProviderToolSchemaError, type ProviderToolSchemaPolicy, type Tool } from '@aotui/agent-driver-v2';
import { buildViewMessageMarkup, collapsedWindowText, escapeXmlText, DESKTOP_TOOL_NAMES as desktopToolNames,
    DEFAULT_AOTUI_SYSTEM_INSTRUCTION, projectNativeToolNames, projectNativeToolSchema, type PresentedRef, type WindowPresentation } from '@aotui/runtime/adapters';
import { isInstanceName, SnapshotDataError } from '@aotui/core';
import { loadAOTUIInstruction } from './load-aotui-instruction.js';
import { formatAppStatus, formatTimestamp } from './presentation.js';
import type { ContextDrivenSource, DrivenSourceContext, MessageWithTimestamp, ToolExecutionBudget, ToolResult } from '@aotui/agent-driver-v2';
import type {
    ActiveTurn, AppID, IDesktop, AppDiscoveryInfo, Observation, InvokeResult, AppInvocation, ObservationCandidate,
    AppWindows, ObservationWindowSelection, ReceiptQuery, UpdateSignal, ViewWindowTarget,
} from '@aotui/runtime';
import { BUDGET_TOOL, budgetHint, budgetPage, fitModelWindows, type BudgetNotice, type RenderedWindows,
    type WindowBudgetContent, type WindowBudgetReport, type WindowCost } from './window-budget.js';
import { createConsoleTool, RUN_CODE, type ConsoleRoutedCall } from './console/console-tool.js';
import { programToolInput, type ProgramToolInput } from './console/declarations.js';
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
    /** Delivers the original locator and the execution result it belongs to. */
    onReceiptPending?: (locator: PendingAppReceipt, result: Readonly<ToolResult>, subcallId?: string) => void;
    /** Trusted Host override. The standard executor uses macOS Seatbelt. */
    consoleExecutor?: ConsoleExecutor;
    maxApps?: number;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const INSPECT_REF = desktopToolNames.inspectRef;
const inspectSchema = {
    type: 'object' as const, additionalProperties: false, required: ['address', 'mode'],
    properties: {
        address: { type: 'string' as const, description: 'Complete $ref.app_id.view_id.ref_id address, with an optional path.' },
        mode: { type: 'string' as const, enum: ['schema', 'value'], description: 'Read the declared structure or a public value from this turn.' },
    },
};
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
    if (result.kind !== 'receipt') return unavailable(toolName, toolCallId, result.code,
        result.message + (result.kind === 'refused' && result.path ? ' At ' + result.path + '.' : ''),
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

async function inspect(turn: ActiveTurn, input: unknown, toolCallId: string): Promise<ToolResult> {
    if (!object(input) || Object.keys(input).length !== 2 || typeof input.address !== 'string' ||
        (input.mode !== 'schema' && input.mode !== 'value')) return unavailable(INSPECT_REF, toolCallId,
        'REF_INSPECTION_INVALID', 'Supply a complete $ref. address and schema or value mode.');
    const result = await turn.inspectRef(input.address, input.mode);
    return result.status === 'ready' ? { toolName: INSPECT_REF, toolCallId, outcomeStatus: 'succeeded',
        result: 'schema' in result ? { schema: result.schema } : { value: result.value } }
        : unavailable(INSPECT_REF, toolCallId, result.issue.code, result.issue.message);
}

interface ToolRoute { app: AppDiscoveryInfo; observationId: string; toolId: string; multiplicity: 'single' | 'multiple'; programInput: ProgramToolInput }
type DisplayedApp = Omit<AppDiscoveryInfo, 'status'> & { status: AppDiscoveryInfo['status'] | 'collapsed' };
interface DisplayedWindows extends AppWindows {
    readonly expanded: boolean;
    readonly views: readonly (AppWindows['views'][number] & { readonly expanded: boolean })[];
}
const displayedStatus = (app: AppDiscoveryInfo, windows?: DisplayedWindows): DisplayedApp['status'] =>
    app.status === 'running' && windows?.expanded === false ? 'collapsed' : app.status;
interface AppIssue { code: string; message: string; path?: string }
interface CapturedObservation { candidate: ObservationCandidate; observation: Observation; released: boolean }
interface AppProjection {
    app: AppDiscoveryInfo;
    captured: CapturedObservation;
    tools: ReadonlyMap<string, Observation['tools'][number]>;
}

interface ContextOwner { release(): void }
type PresentationEntry = { displayed?: { digest: string; timestamp: number }; bodyBytes?: number; restoreBody?: true };
type Expansion = { appId: AppID; instanceId: string; view?: ViewWindowTarget; bodies: ReadonlySet<string> };
type BudgetReportScope = readonly { installationId: string; appId: AppID; instanceId: string;
    views: ObservationWindowSelection['refViews'] }[];
type StoredReport = { report: WindowBudgetReport; scope: BudgetReportScope; key: string; until: number };
type Control = (input: unknown, callId: string, current: () => ActiveTurn | undefined, budget?: ToolExecutionBudget) => Promise<ToolResult>;
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
    captured.candidate.discard();
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
    private readonly windowNotes = new Map<string, Map<string, string>>();
    private windowRevision = Symbol();
    private readonly contexts = new Set<ContextOwner>();
    private readonly listeners = new Set<() => void>();
    private readonly pendingAttention = new Map<string, UpdateSignal>();
    private readonly update = () => { for (const listener of this.listeners) listener(); };
    private readonly requestAttention: Parameters<IDesktop['output']['subscribe']>[0] = signal => {
        if (signal.reason !== 'attention_requested' || this.disposed || !this.enabled || !this.appsEnabled) return;
        const app = this.desktop.listApps().find(item => item.appId === signal.appId && item.appInstanceId === signal.instanceId);
        if (app?.status !== 'running' || !this.isAppEnabled(app.installationId)) return;
        this.pendingAttention.set(app.installationId, signal);
        this.update();
    };
    private subscribed = false;
    private readonly maxApps: number;
    private readonly consoleExecutor: ConsoleExecutor;
    private readonly instruction: string;
    private presentations = new Map<string, PresentationEntry>();
    private presentationTime = 1;
    private readonly reports = new Map<string, StoredReport>();

    constructor(private readonly desktop: IDesktop, private readonly options: SemanticAOTUIDrivenSourceOptions = {}) {
        this.maxApps = options.maxApps ?? 128;
        this.consoleExecutor = options.consoleExecutor ?? createNodeScopedConsoleExecutor();
        this.instruction = loadAOTUIInstruction(options, DEFAULT_AOTUI_SYSTEM_INSTRUCTION);
        if (!Number.isSafeInteger(this.maxApps) || this.maxApps < 1) throw new Error('SEMANTIC_SOURCE_LIMIT_INVALID');
    }

    listApps(): readonly AppDiscoveryInfo[] {
        if (this.disposed) return [];
        const apps = this.desktop.listApps();
        if (apps.length > this.maxApps) throw new Error('SEMANTIC_APP_CAPACITY');
        // Do not expose launch configuration, paths, credentials, or mutable registry records.
        return apps.map(app => ({ installationId: app.installationId,
            ...(app.appId && app.appInstanceId ? { appId: app.appId, appInstanceId: app.appInstanceId } : {}),
            name: app.name, status: app.status,
            description: app.description, whatItIs: app.whatItIs, whenToUse: app.whenToUse }));
    }

    private currentApp(installationId: string): AppDiscoveryInfo | undefined {
        for (const candidate of this.desktop.listApps()) {
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
                if (!['pending', 'running', 'closed'].includes(status as string)) return undefined;
                const name = value('name'), appId = value('appId');
                if (typeof name !== 'string') return undefined;
                const appInstanceId = value('appInstanceId');
                return { installationId, name, status: status as AppDiscoveryInfo['status'],
                    ...(typeof appId === 'string' && typeof appInstanceId === 'string' ? { appId: appId as AppID, appInstanceId } : {}) };
            } catch { return undefined; }
        }
        return undefined;
    }

    private allowed(app: Pick<AppDiscoveryInfo, 'installationId'>): boolean {
        return this.isAppEnabled(app.installationId);
    }

    isAppEnabled(installationId: string): boolean {
        return this.enabled && this.appsEnabled && !this.disposed && !this.disabledApps.has(installationId);
    }

    private async invokeApp(turn: ActiveTurn, route: ToolRoute, name: string, args: unknown, id: string,
        signal?: AbortSignal): Promise<ConsoleRoutedCall> {
        if (signal?.aborted) return { result: unavailable(name, id, 'INVOCATION_CANCELLED', 'Cancelled before dispatch.') };
        if (!this.allowed(route.app)) return { result: unavailable(name, id, 'APP_DISABLED', 'This application is disabled.') };
        if (!object(args)) return { result: unavailable(name, id, 'INVOCATION_INVALID', 'Tool input must be an object.') };
        const pending = (): PendingAppReceipt | undefined => {
            const { appId, appInstanceId } = route.app;
            if (appId && appInstanceId) return Object.freeze({ desktopId: this.desktop.id, appId, appInstanceId,
                observationId: route.observationId, invocationId: id });
        };
        const fields = Object.getOwnPropertyDescriptors(args);
        const receiver = Object.hasOwn(fields, 'view_id') ? fields.view_id : undefined;
        const viewId = receiver?.enumerable && Object.hasOwn(receiver, 'value') ? receiver.value : undefined;
        if (route.multiplicity === 'multiple' && (typeof viewId !== 'string' || !viewId) ||
            route.multiplicity === 'single' && receiver !== undefined)
            return { result: unavailable(name, id, 'TOOL_INVALID_ARGS', route.multiplicity === 'multiple'
                ? 'Choose the receiving page with its string view_id ($.view_id).' : 'This single-instance tool takes no view_id ($.view_id).') };
        delete fields.view_id;
        const input = Object.defineProperties(Object.create(null), fields) as AppInvocation['input'];
        try {
            const request: AppInvocation = { invocationId: id, observationId: route.observationId, toolId: route.toolId,
                ...(typeof viewId === 'string' ? { viewId } : {}), input };
            const invoked = await turn.invoke(route.app.appId!, request, undefined, signal);
            const locator = invoked.locator;
            return { result: semanticToolResult(name, id, invoked),
                ...(invoked.kind === 'receipt' ? { receipt: invoked.receipt } : {}),
                ...(invoked.kind === 'unavailable' && (invoked.code === 'INVOCATION_WAIT_TIMEOUT' || invoked.code === 'INVOCATION_WAIT_CANCELLED')
                    ? { pending: locator ? { desktopId: locator.desktopId, appId: locator.appId, appInstanceId: locator.instanceId,
                        observationId: locator.observationId, invocationId: locator.invocationId } : pending() } : {}) };
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

    private runningApp(app: AppDiscoveryInfo) {
        const { appId, appInstanceId: instanceId } = app;
        if (!appId || !instanceId) throw new AppProjectionError('APP_INTERACTION_UNAVAILABLE', 'No running App instance to observe.');
        const access = this.desktop.getRunningApp(appId, instanceId);
        if (access.status === 'rejected') throw new AppProjectionError(access.issue.code, access.issue.message, access.issue.path);
        return access.app;
    }

    getContext(toolSchema?: ProviderToolSchemaPolicy): Promise<DrivenSourceContext> { return this.prepareContext(toolSchema); }

    private displayWindows(windows: AppWindows): DisplayedWindows {
        const notes = this.windowNotes.get(windows.instanceId);
        return { ...windows, expanded: !notes?.has(''),
            views: windows.views.map(view => ({ ...view, expanded: !notes?.has(view.viewInstanceId) })) };
    }

    private currentWindows(appId: AppID, instanceId: string): DisplayedWindows | undefined {
        const windows = this.desktop.getAppWindows(appId, instanceId);
        return windows && this.displayWindows(windows);
    }

    private async prepareContext(toolSchema?: ProviderToolSchemaPolicy, expansion?: Expansion): Promise<DrivenSourceContext> {
        if (this.disposed || !this.enabled) return { messages: [], tools: {} };
        if (this.contexts.size >= 2) throw new Error('SEMANTIC_CONTEXT_CAPACITY');
        const generation = this.generation;
        const windowRevision = this.windowRevision;
        const attention = new Map(expansion ? [] : this.pendingAttention);
        const observations: CapturedObservation[] = [];
        const consoleLifetime = new AbortController();
        let released = false;
        let adopted: DrivenSourceContext | undefined;
        let turn: ActiveTurn | undefined;
        const owner: ContextOwner = { release: () => {
            if (released) return;
            released = true;
            consoleLifetime.abort();
            turn?.release();
            turn = undefined;
            for (const observed of observations) releaseCaptured(observed);
            observations.length = 0;
            this.contexts.delete(owner);
        } };
        this.contexts.add(owner);
        try {
            const appsEnabled = this.appsEnabled;
            const installedApps = appsEnabled ? this.listApps() : [];
            const apps = installedApps.filter(app => this.allowed(app));
            if (appsEnabled) {
                const installedInstances = new Set(installedApps.map(app => app.appInstanceId));
                for (const id of this.windowNotes.keys()) if (!installedInstances.has(id)) this.windowNotes.delete(id);
            }
            const previous = this.presentations;
            const presentationTime = Math.max(Date.now(), this.presentationTime);
            const issues = new Map<string, AppIssue>();
            const preparedApps: Pick<AppProjection, 'app' | 'captured'>[] = [];
            for (const app of apps) {
                const { appId, name: appName, installationId } = app;
                if (!appId || !app.appInstanceId || app.status !== 'running') continue;
                if (expansion?.appId !== appId && this.windowNotes.get(app.appInstanceId)?.has('')) continue;
                let candidate: ObservationCandidate | undefined;
                try {
                    if (!isInstanceName(appName) || !isInstanceName(appId))
                        throw new AppProjectionError('AOTUI_APP_IDENTITY_INVALID',
                            'App names and IDs use ASCII letters, digits and underscores and must include a nondigit.');
                    const observed = await this.runningApp(app).observe();
                    if (observed.status !== 'prepared') {
                        const { code, message, path } = observed.issue;
                        throw new AppProjectionError(code, message, path);
                    }
                    candidate = observed.candidate;
                    const { observation } = candidate;
                    if (released || this.generation !== generation) {
                        candidate.discard();
                        continue;
                    }

                    if (observation.tools.some(tool => !object(tool.inputSchema)))
                        throw new AppProjectionError('AOTUI_TOOL_SCHEMA_INVALID',
                            'This App Tool has an invalid input schema. Declare a JSON Schema object and refresh the context.');
                    const captured: CapturedObservation = { candidate, observation, released: false };
                    if (!observation.views.length && !observation.tools.length) {
                        releaseCaptured(captured);
                        continue;
                    }
                    observations.push(captured);
                    preparedApps.push({ app, captured });
                } catch (error) {
                    candidate?.discard();
                    issues.set(installationId, appIssueFrom(error));
                }
            }

            const names = projectNativeToolNames(preparedApps.map(({ captured }) => captured.observation));
            const projections: AppProjection[] = preparedApps.flatMap((app, index) => {
                const projection = names[index]!;
                if (projection.status === 'ready') return [{ ...app, tools: projection.tools }];
                const { code, message, path } = projection.issue;
                issues.set(app.app.installationId, boundedIssue(code, message, path));
                releaseCaptured(app.captured);
                return [];
            });
            const catalog = new Map<string, DisplayedWindows>();
            for (const app of apps) {
                if (!app.appId || !app.appInstanceId) continue;
                const windows = this.desktop.getAppWindows(app.appId, app.appInstanceId);
                if (!windows) continue;
                const notes = this.windowNotes.get(windows.instanceId);
                if (notes) {
                    const mounts = new Set(windows.views.map(view => view.viewInstanceId));
                    for (const key of notes.keys()) if (key && !mounts.has(key)) notes.delete(key);
                }
                catalog.set(app.appId, this.displayWindows(windows));
            }
            for (const [installationId, signal] of attention) {
                if (catalog.get(signal.appId)?.instanceId === signal.instanceId) continue;
                attention.delete(installationId);
                if (this.pendingAttention.get(installationId) === signal) this.pendingAttention.delete(installationId);
            }
            const displayCatalog = expansion ? new Map(catalog) : catalog;
            if (expansion) {
                const expanding = apps.find(app => app.appId === expansion.appId && app.appInstanceId === expansion.instanceId);
                const projection = projections.find(item => item.app === expanding);
                const mount = expansion.view?.viewInstanceId;
                const window = catalog.get(expansion.appId);
                const required = mount === undefined ? window?.views : window?.views.filter(view => view.viewInstanceId === mount);
                if (!expanding || !window || issues.has(expanding.installationId) || (mount !== undefined && !required?.length) ||
                    required?.some(view => !projection?.captured.observation.views.some(observed =>
                        observed.id === view.viewId && observed.viewInstanceId === view.viewInstanceId)))
                    throw new AppProjectionError('WINDOW_EXPANSION_UNAVAILABLE', 'The expanded Window could not be observed.');
                displayCatalog.set(expansion.appId, mount === undefined ? { ...window, expanded: true } : { ...window,
                    views: window.views.map(view => view.viewInstanceId === mount ? { ...view, expanded: true } : view) });
            }
            const displayApp = (app: AppDiscoveryInfo): DisplayedApp =>
                ({ ...app, status: displayedStatus(app, app.appId ? displayCatalog.get(app.appId) : undefined) });
            const displayed = apps.map(displayApp);
            const viewNotes = new Map<string, string>();
            for (const app of displayCatalog.values()) for (const view of app.views) {
                if (!view.expanded) viewNotes.set(windowKey(app.appId, view.viewInstanceId),
                    this.windowNotes.get(app.instanceId)?.get(view.viewInstanceId) ?? '');
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
                const windows: WindowCost[] = [];
                const presentations = new Map<string, PresentationEntry>();
                const selections = new Map<string, ObservationWindowSelection>();
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
                const visibleApps = projections.flatMap(projection => {
                    const { captured: { observation }, app, tools: declared } = projection;
                    if (managementOnly || displayApp(app).status !== 'running') return [];
                    const { source } = observation;
                    const views = observation.views.filter(view => !viewNotes.has(windowKey(source.appId, view.viewInstanceId)));
                    const receiverViews = views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
                    const refViews = receiverViews.filter(view => !hints.has(windowKey(source.appId, view.viewInstanceId)));
                    selections.set(source.appId, { receiverViews, refViews });
                    const bodies = new Set(refViews.map(view => view.viewInstanceId));
                    const refs: PresentedRef[] = observation.refs.filter(ref => bodies.has(ref.viewInstanceId)).map(ref => ({ source, ref }));
                    const live = [...declared].flatMap(([name, tool]) => {
                        const receivers = receiverViews.filter((_, index) => views[index]!.type === tool.viewType &&
                            (!tool.eligibleViewIds || tool.eligibleViewIds.includes(views[index]!.id)));
                        return receivers.length ? [{ name, tool, receivers }] : [];
                    });
                    return [{ app, observation, refs, live }];
                });
                // Schema support is evaluated using the same visible receiver and Ref sets that will be adopted.
                let visibleRefs: readonly PresentedRef[];
                for (;;) {
                    routes.clear();
                    for (const key of Object.keys(tools)) delete tools[key];
                    const current = visibleApps.filter(({ app }) => !renderIssues.has(app.installationId));
                    visibleRefs = current.flatMap(app => app.refs);
                    let removed = false;
                    for (const { app, observation, live } of current) for (const { name, tool, receivers } of live) {
                        try {
                            const input = projectNativeToolSchema(tool, observation.source, receivers, visibleRefs);
                            const issue = toolSchema?.check?.(input);
                            if (issue) throw new ProviderToolSchemaError(toolSchema!.label, name, issue.path, issue.reason);
                            tools[name] = { description: tool.description + '\nApp ID ' + observation.source.appId +
                                ', view_type ' + tool.viewType + ' (' + tool.multiplicity + ').', inputSchema: jsonSchema(input) };
                            routes.set(name, { app, observationId: observation.observationId, toolId: tool.id,
                                multiplicity: tool.multiplicity, programInput: programToolInput(input, tool.inputSchema) });
                        } catch (error) {
                            if (expansion?.appId === observation.source.appId) throw error;
                            const issue = error instanceof ProviderToolSchemaError
                                ? boundedIssue(error.code, error.message, error.path)
                                : error instanceof SnapshotDataError
                                    ? boundedIssue(error.code, name + ': ' + error.message, error.path) : appIssueFrom(error);
                            renderIssues.set(app.installationId, issue);
                            selections.delete(observation.source.appId);
                            removed = true;
                            break;
                        }
                    }
                    if (!removed) break;
                }
                const inspectIssue = visibleRefs.length ? toolSchema?.check?.(inspectSchema) : undefined;
                const canInspect = visibleRefs.length > 0 && !inspectIssue;
                if (canInspect) tools[INSPECT_REF] = {
                    description: 'Read a visible Ref’s declared schema or the original value of a public Ref.',
                    inputSchema: jsonSchema(inspectSchema),
                };
                else if (inspectIssue) {
                    const content = formatAppIssue(boundedIssue('MODEL_TOOL_SCHEMA_UNSUPPORTED',
                        'The Ref inspection tool cannot be encoded. ' + inspectIssue.reason, inspectIssue.path));
                    messages.push({ role: 'user', region: 'dynamic', content, timestamp: timestamp('ref-inspection-availability', content) });
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
                        const markup = buildViewMessageMarkup({ appId, appName: projection.app.name, viewId: view.id, viewType: view.type,
                            markup: note !== undefined ? collapsedWindowText(note) : body ? view.content.value
                                : budgetHint(Buffer.byteLength(view.content.value, 'utf8'), notice!.full), refs });
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
                        const note = app.status === 'collapsed' && window ? this.windowNotes.get(window.instanceId)?.get('') ?? '' : undefined;
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
                                const collapsed = !view.expanded;
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
                    [...[...routes].map(([name, route]) => ({ name, input: route.programInput })),
                        ...(visibleRefs.length ? [{ name: INSPECT_REF, input: { schema: inspectSchema, refOnly: [] } }] : [])],
                    visibleRefs, this.consoleExecutor, toolSchema?.strict === true);
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
                for (const { appId, timestamp } of attention.values()) {
                    const id = escapeXmlText(appId).replace(/"/g, '&quot;');
                    messages.push({ role: 'user', region: 'request', timestamp,
                        content: `<aotui_attention app_id="${id}" source="host">\n` +
                            'This App requests your attention now. Read its latest View messages.\n</aotui_attention>' });
                }
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
                        if (this.windowRevision !== windowRevision)
                            throw Object.assign(new Error('A Window changed while preparing the model request.'), { code: 'SEMANTIC_WINDOW_CHANGED' });
                        for (const [appId, expected] of catalog) {
                            const current = this.currentWindows(appId as AppID, expected.instanceId);
                            if (JSON.stringify(current) !== JSON.stringify(expected))
                                throw Object.assign(new Error('A Window changed while preparing the model request.'), { code: 'SEMANTIC_WINDOW_CHANGED' });
                        }
                        const selected = observations.flatMap(item => {
                            const windows = selections.get(item.observation.source.appId);
                            if (!windows || (!windows.receiverViews.length && !windows.refViews.length)) releaseCaptured(item);
                            return !item.released && windows ? [{ candidate: item.candidate, windows }] : [];
                        });
                        const result = this.desktop.adoptTurn({ apps: selected });
                        if (result.status === 'rejected') {
                            owner.release();
                            throw Object.assign(new Error('The prepared context could not be adopted.'), {
                                code: 'SEMANTIC_ADOPTION_FAILED', cause: result.issue,
                            });
                        }
                        turn = result.turn;
                        if (!turn.isCurrent || released || this.generation !== generation) {
                            turn.release();
                            owner.release();
                            throw Object.assign(new Error('The App selection changed during adoption.'), { code: 'SEMANTIC_CONTEXT_RELEASED' });
                        }
                        for (const prior of this.contexts) if (prior !== owner) prior.release();
                        this.presentations = presentations;
                        this.presentationTime = nextTimestamp;
                        for (const [installationId, signal] of attention) {
                            if (this.pendingAttention.get(installationId) === signal) this.pendingAttention.delete(installationId);
                        }
                        adopted = context;
                    },
                    executeTool: async (name, args, callId, budget, signal) => {
                        if (released || this.disposed || !this.enabled) return name in tools ? unavailable(name, callId, 'SEMANTIC_CONTEXT_RELEASED', 'This observation was released; obtain a new context.') : undefined;
                        if (adopted !== context) return name in tools ? unavailable(name, callId, 'SEMANTIC_CONTEXT_NOT_ADOPTED', 'Adopt this prepared context before invoking its tools.') : undefined;
                        const active = turn;
                        if (!active?.isCurrent) return name in tools ? unavailable(name, callId, 'TURN_NOT_ACTIVE', 'Use the currently adopted Desktop turn.') : undefined;
                        if (name === RUN_CODE && consoleTool) {
                            const cancellation = signal ? AbortSignal.any([signal, consoleLifetime.signal]) : consoleLifetime.signal;
                            return consoleTool.execute(args, callId, active, cancellation, async (name, input, childId, childSignal) => {
                                if (name === INSPECT_REF && visibleRefs.length) return { result: await inspect(active, input, childId) };
                                const route = routes.get(name);
                                return route ? this.invokeApp(active, route, name, input, childId, childSignal)
                                    : { result: unavailable(name, childId, 'TOOL_UNAVAILABLE', 'This Tool was not published in the original request.') };
                            }, (locator, result) => this.reportPendingReceipt(locator, result, locator.invocationId));
                        }
                        if (name === INSPECT_REF && canInspect) return inspect(active, args, callId);
                        const handler = control?.get(name);
                        if (handler) return handler(args, callId, () => !released && active.isCurrent ? active : undefined, budget);
                        const route = routes.get(name);
                        if (!route) return undefined;
                        const called = await this.invokeApp(active, route, name, args, callId, signal);
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

    private setVisibility(turn: ActiveTurn, appId: AppID, instanceId: string, expanded: boolean, target?: ViewWindowTarget, note = '') {
        const key = target?.viewInstanceId ?? '';
        let notes = this.windowNotes.get(instanceId);
        if (expanded) {
            notes?.delete(key);
            if (!notes?.size) this.windowNotes.delete(instanceId);
        } else {
            this.desktop.revokeWindowAccess(turn, target ?? { appId, instanceId });
            if (!notes) { notes = new Map(); this.windowNotes.set(instanceId, notes); }
            notes.set(key, note);
        }
        this.windowRevision = Symbol();
    }

    private controls(apps: readonly DisplayedApp[], catalog: ReadonlyMap<string, DisplayedWindows>,
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
            const allowsStatus = (status: DisplayedApp['status']) => (statuses as readonly DisplayedApp['status'][]).includes(status);
            const targets = new Map(apps.filter(app => allowsStatus(app.status)).flatMap(app => {
                const id = opening ? app.installationId : app.appId && app.appInstanceId ? app.appId : undefined;
                return id ? [[id, app] as const] : [];
            }));
            if (!opening && action !== 'close' && (!targets.size || (isView && ![...targets.keys()].some(id =>
                catalog.get(id)?.views.some(view => action === 'closeView' ? view.canClose : view.expanded !== expanding))))) continue;
            const name = desktopToolNames[action];
            addRequiredTool(name, description, { type: 'object', properties: {
                [fieldName]: { type: 'string' }, ...(isView ? { view_id: { type: 'string' } } : {}),
                ...(notes ? { note: { type: 'string', description: 'Note to show in place of the content. Use an empty string for no note.' } } : {}),
            }, required, additionalProperties: false });
            handlers.set(name, async (input, callId, current, budget) => {
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
                if (!app)
                    return unavailable(name, callId, 'APP_STATE_CHANGED', 'The application state changed; refresh the context.');
                if (!opening && (!app.appId || app.appId !== captured.appId || app.appInstanceId !== captured.appInstanceId))
                    return unavailable(name, callId, 'APP_INSTANCE_CHANGED', 'The application instance changed; refresh the context.');

                const capturedView = isView && captured.appId ? catalog.get(captured.appId)?.views.find(view => view.viewId === viewId) : undefined;
                if (isView && !capturedView)
                    return unavailable(name, callId, 'INVALID_VIEW_TARGET', 'Select a view_id from the current Desktop.');
                const window = capturedView && app.appId && app.appInstanceId ? {
                    appId: app.appId, instanceId: app.appInstanceId, viewId: capturedView.viewId, viewInstanceId: capturedView.viewInstanceId,
                } : undefined;
                const liveCatalog = app.appId && app.appInstanceId ? this.currentWindows(app.appId, app.appInstanceId) : undefined;
                if (!allowsStatus(displayedStatus(app, liveCatalog)))
                    return unavailable(name, callId, 'APP_STATE_CHANGED', 'The application state changed; refresh the context.');
                if (window) {
                    const live = liveCatalog?.views.find(view => view.viewId === window.viewId && view.viewInstanceId === window.viewInstanceId);
                    if (!live) return unavailable(name, callId, 'VIEW_INSTANCE_REVOKED', 'The selected View closed or was replaced.');
                    if (action === 'closeView' && (!capturedView!.canClose || !live.canClose))
                        return unavailable(name, callId, 'VIEW_CLOSE_UNAVAILABLE', 'This View has no independent close action. Collapse the View or close its App.');
                    if (action !== 'closeView' && live.expanded === expanding)
                        return unavailable(name, callId, 'VIEW_STATE_CHANGED', 'The window state changed; refresh the context.');
                }

                const apply = async (): Promise<ToolResult> => {
                    try {
                        const started = current();
                        if (!started) return unavailable(name, callId, 'TURN_NOT_ACTIVE', 'Use the currently adopted Desktop turn.');
                        const appId = opening ? (await this.desktop.openApp(app.installationId)).appId : app.appId!;
                        const success: ToolResult = { toolName: name, toolCallId: callId, outcomeStatus: 'succeeded',
                            result: { success: true, app_id: appId, ...(window ? { view_id: window.viewId } : {}) } };
                        const bodies = new Set<string>();
                        if (expanding && budget && app.appInstanceId) {
                            const generation = this.generation;
                            const windowRevision = this.windowRevision;
                            for (const view of window ? [window] : liveCatalog?.views.filter(view => view.expanded) ?? [])
                                bodies.add(windowKey(appId, view.viewInstanceId));
                            const issue = await this.checkExpansion({ appId, instanceId: app.appInstanceId, bodies,
                                ...(window ? { view: window } : {}) }, budget, success, toolSchema);
                            if (issue) return issue;
                            if (!current() || this.generation !== generation || this.windowRevision !== windowRevision || !this.allowed(captured) ||
                                JSON.stringify(liveCatalog) !== JSON.stringify(this.currentWindows(appId, app.appInstanceId)))
                                return unavailable(name, callId, 'VIEW_STATE_CHANGED', 'The window changed during budget preflight. Observe the current Desktop.');
                        }
                        const turn = opening ? started : current();
                        if (!turn) return unavailable(name, callId, 'TURN_NOT_ACTIVE', 'Use the currently adopted Desktop turn.');
                        switch (action) {
                            case 'close': {
                                const report = await this.runningApp(app).beginClose().completion;
                                if (!report.ok) {
                                    this.update();
                                    return { ...success, outcomeStatus: 'failed', result: { success: false, app_id: appId,
                                        resources_released: report.resourcesReleased }, error: { code: 'APP_CLOSE_FAILED',
                                        message: report.resourcesReleased ? 'The App released its resources and reported a cleanup failure.'
                                            : 'The App stopped accepting work. The Host can retry release of its remaining resources.' } };
                                }
                                break;
                            }
                            case 'collapse': case 'expand': case 'collapseView': case 'expandView':
                                this.setVisibility(turn, appId, app.appInstanceId!, expanding, window, note); break;
                            case 'closeView': {
                                const closed = await this.desktop.closeView(window!, turn);
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
                        if (code === 'TURN_NOT_ACTIVE') return unavailable(name, callId, code, 'Use the currently adopted Desktop turn.');
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
        if (!enabled) this.pendingAttention.clear();
        this.invalidateContexts();
    }
    /** Enable App presentation and routing while keeping the system Console available. */
    setAppsEnabled(enabled: boolean): void {
        if (this.disposed || this.appsEnabled === enabled) return;
        this.appsEnabled = enabled;
        if (!enabled) this.pendingAttention.clear();
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
        if (this.disposed || !installationId || enabled === !this.disabledApps.has(installationId)) return;
        if (enabled) this.disabledApps.delete(installationId);
        else {
            this.disabledApps.add(installationId);
            this.pendingAttention.delete(installationId);
        }
        this.invalidateContexts();
    }
    onUpdate(callback: () => void): () => void {
        if (this.disposed) throw new Error('SEMANTIC_SOURCE_DISPOSED');
        this.listeners.add(callback);
        if (!this.subscribed) { this.desktop.output.subscribe(this.requestAttention); this.subscribed = true; }
        return () => {
            this.listeners.delete(callback);
            if (!this.listeners.size && this.subscribed) { this.desktop.output.unsubscribe(this.requestAttention); this.subscribed = false; }
        };
    }
    dispose(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = Promise.resolve().then(() => this.consoleExecutor.dispose?.());
        this.disposed = true; this.generation++; this.presentations.clear();
        for (const owner of this.contexts) owner.release();
        this.pendingAttention.clear();
        this.windowNotes.clear();
        this.reports.clear();
        if (this.subscribed) this.desktop.output.unsubscribe(this.requestAttention);
        this.subscribed = false; this.listeners.clear();
        return this.closing;
    }
}
