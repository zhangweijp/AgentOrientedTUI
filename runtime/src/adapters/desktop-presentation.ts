import { SnapshotDataError } from '@aotui/core';
import type { AppInvocation, InteractionIssue, JsonValue, Observation, ObservationWindowSelection } from '@aotui/core';
import type { AppDiscoveryInfo } from '../spi/runtime/kernel.interface.js';
import type { AppWindows } from '../spi/runtime/windows.js';
import { DESKTOP_TOOL_NAMES, projectNativeToolNames } from './public-tool-name.js';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from './system-instruction.js';
import { projectNativeToolSchema, type PresentedRef } from './tool-projection.js';
import { buildViewMessageMarkup, collapsedWindowText, escapeXmlText } from './view-message.js';

export type ViewPresentation = { kind: 'body' } | { kind: 'omitted' } | { kind: 'hint'; text?: string } |
    { kind: 'collapsed'; note?: string };
export type DesktopCapability = keyof typeof DESKTOP_TOOL_NAMES;
export interface PresentedAppWindows extends AppWindows {
    readonly expanded: boolean;
    readonly views: readonly (AppWindows['views'][number] & { readonly expanded: boolean })[];
}
interface CatalogEntry {
    app: AppDiscoveryInfo;
    windows?: PresentedAppWindows;
    note?: string;
    issue?: InteractionIssue;
}
export interface NativeTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, JsonValue>>;
    readonly route?: {
        readonly appId: string;
        readonly instanceId: string;
        readonly observationId: string;
        readonly toolId: string;
        readonly multiplicity: 'single' | 'multiple';
        readonly businessSchema: NativeTool['inputSchema'];
    };
}

export const inspectRefSchema = {
    type: 'object', additionalProperties: false, required: ['address', 'mode'],
    properties: {
        address: { type: 'string', description: 'Complete $ref.app_id.view_id.ref_id address, with an optional path.' },
        mode: { type: 'string', enum: ['schema', 'value'], description: 'Read the declared structure or a public value from this turn.' },
    },
} as const satisfies NativeTool['inputSchema'];

const status = ({ app, windows }: CatalogEntry) => app.status === 'running' && windows?.expanded === false ? 'collapsed' : app.status;

export function projectDesktop(input: {
    apps: readonly { observation: Observation; windows?: ReadonlyMap<string, ViewPresentation> }[];
    catalog: readonly CatalogEntry[];
    capabilities: readonly DesktopCapability[];
    includeInstruction?: boolean;
    compact?: boolean;
    strict?: boolean;
    checkTool?: (name: string, schema: NativeTool['inputSchema'], source?: Observation['source']) => InteractionIssue | undefined;
    desktopSuffix?: string;
    emptyCatalogText?: string;
}) {
    const byApp = new Map(input.apps.map(projection => [projection.observation.source.appId, projection]));
    const entries: CatalogEntry[] = input.catalog.map(entry => {
        const { app, windows } = entry;
        if (!windows) return entry;
        if (windows.appId !== app.appId || windows.instanceId !== app.appInstanceId)
            return { app, ...(entry.issue ? { issue: entry.issue } : {}) };
        const captured = byApp.get(windows.appId);
        if (captured?.observation.source.instanceId !== windows.instanceId) return entry;
        const mounts = new Set(captured.observation.views.map(view => view.viewInstanceId));
        return { ...entry, windows: { ...windows, views: windows.views.map(view => mounts.has(view.viewInstanceId)
            ? { ...view, expanded: captured.windows?.get(view.viewInstanceId)?.kind !== 'collapsed' } : view) } };
    });
    const catalog = new Map<string, CatalogEntry>(entries.flatMap(entry =>
        entry.app.appId ? [[entry.app.appId, entry]] : []));
    const observed = input.apps.filter(({ observation: { source } }) => {
        const entry = catalog.get(source.appId);
        return entry?.app.status === 'running' && entry.app.appInstanceId === source.instanceId;
    });
    const issues: { observationId: string; appId: string; issue: InteractionIssue }[] = [];
    const names = projectNativeToolNames(observed.map(({ observation }) => observation));
    const active = observed.flatMap(({ observation, windows }, index) => {
        const named = names[index]!;
        const { observationId, source: { appId } } = observation;
        if (named.status === 'rejected') {
            issues.push({ observationId, appId, issue: named.issue });
            return [];
        }
        if (input.compact || catalog.get(appId)?.windows?.expanded === false) return [];
        if (observation.tools.some(({ inputSchema }) => inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema))) {
            issues.push({ observationId, appId, issue: { code: 'AOTUI_TOOL_SCHEMA_INVALID',
                message: 'This App Tool has an invalid input schema. Declare a JSON Schema object and refresh the context.' } });
            return [];
        }
        const views = observation.views.map(view => ({
            view, presentation: windows?.get(view.viewInstanceId) ?? { kind: 'body' } as const,
        }));
        const bodies = views.filter(({ presentation }) => presentation.kind === 'body').map(({ view }) => view);
        const refs = observation.refs.filter(ref => bodies.some(view => view.viewInstanceId === ref.viewInstanceId && view.id === ref.viewId));
        return [{ observation, views, bodies, refs, named: named.tools }];
    });

    const denied = new Set<string>();
    let refs: PresentedRef[];
    let business: NativeTool[];
    for (;;) {
        const current = active.filter(({ observation }) => !denied.has(observation.source.appId));
        refs = current.flatMap(({ observation, refs }) => refs.map(ref => ({ source: observation.source, ref })));
        business = [];
        for (const { observation, bodies, named } of current) {
            const { observationId, source } = observation;
            const { appId, instanceId } = source;
            for (const [name, tool] of named) {
                const receivers = bodies.filter(view => view.type === tool.viewType &&
                    (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id)))
                    .map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
                if (!receivers.length) continue;
                let issue: InteractionIssue | undefined;
                try {
                    const inputSchema = projectNativeToolSchema(tool, source, receivers, refs);
                    issue = input.checkTool?.(name, inputSchema, source);
                    if (!issue) business.push({ name, description: tool.description + '\nApp ID ' + appId +
                        ', view_type ' + tool.viewType + ' (' + tool.multiplicity + ').', inputSchema,
                    route: { appId, instanceId, observationId, toolId: tool.id, multiplicity: tool.multiplicity, businessSchema: tool.inputSchema } });
                } catch (error) {
                    if (!(error instanceof SnapshotDataError)) throw error;
                    issue = { code: error.code, message: name + ': ' + error.message, ...(error.path ? { path: error.path } : {}) };
                }
                if (issue) {
                    issues.push({ observationId, appId, issue });
                    denied.add(appId);
                    break;
                }
            }
        }
        if (current.every(({ observation }) => !denied.has(observation.source.appId))) break;
    }

    const views = [];
    const appSelections = [];
    for (const { observation, views: pages, bodies, refs } of active) {
        const { observationId, source: { appId } } = observation;
        if (denied.has(appId)) continue;
        const appName = catalog.get(appId)?.app.name ?? appId;
        const windows: ObservationWindowSelection = { activeViews: bodies.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })) };
        if (windows.activeViews.length) appSelections.push({ observationId, appId, windows });
        for (const { view, presentation } of pages) {
            if (presentation.kind === 'omitted') continue;
            const { id: viewId, viewInstanceId, region } = view;
            const markup = presentation.kind === 'body' ? view.content.value :
                presentation.kind === 'collapsed' ? collapsedWindowText(presentation.note ?? '') :
                    presentation.text ?? 'This View is open. Its body is omitted this turn for the model context budget.';
            const content = buildViewMessageMarkup({ appId, appName, viewId, viewType: view.type, region, markup,
                refs: refs.filter(ref => ref.viewId === viewId && ref.viewInstanceId === viewInstanceId) });
            views.push({ appId, viewId, viewInstanceId, region, content, kind: presentation.kind });
        }
    }

    const systemIssues: { name: string; issue: InteractionIssue }[] = [];
    const tools = [...business];
    for (const tool of systemTools(entries, input.capabilities, refs.length > 0, input.strict === true)) {
        const issue = input.checkTool?.(tool.name, tool.inputSchema);
        if (issue) systemIssues.push({ name: tool.name, issue });
        else tools.push(tool);
    }
    const offered = new Set(tools.map(({ name }) => name));
    const directory = entries.map((entry, index) => {
        const { app, windows, note } = entry;
        const appStatus = status(entry);
        const issue = entry.issue ?? issues.find(issue => issue.appId === app.appId)?.issue;
        const esc = escapeXmlText;
        const action = (key: DesktopCapability) => offered.has(DESKTOP_TOOL_NAMES[key]);
        const appActions = appStatus === 'running' ? ['collapse', 'close'] as const : appStatus === 'collapsed'
            ? ['expand', 'close'] as const : ['open'] as const;
        const actions = (appStatus === 'running' || appStatus === 'collapsed') && (!app.appId || !app.appInstanceId)
            ? '' : appActions.filter(action).join(', ');
        return [
            `${index + 1}. ${esc(app.name)}`, `    - installation_id: ${esc(app.installationId)}`,
            ...(app.appId ? [`    - app_id: ${esc(app.appId)}`] : []),
            `    - Status: ${{ pending: 'available (not started)', closed: 'not launched', running: 'running', collapsed: 'minimized' }[appStatus]}`,
            ...(actions ? [`    - Actions: ${actions}`] : []),
            ...(appStatus === 'collapsed' && !input.compact ? ['    - ' + esc(collapsedWindowText(note ?? ''))] : []),
            ...(!input.compact ? [`    - What it is: ${esc(app.whatItIs || app.description || 'Not provided')}`,
                `    - When to use: ${esc(app.whenToUse || 'Not provided')}`] : []),
            ...(issue ? [`    - Semantic status: ${esc(issue.code)}: ${esc(issue.message)}${issue.path ? ` (at ${esc(issue.path)})` : ''}`] : []),
            ...(appStatus === 'running' ? (windows?.views ?? []).map(view => {
                const actions = [view.expanded ? 'open' : 'collapsed', ...(view.expanded && action('collapseView') ? ['collapse'] : []),
                    ...(!view.expanded && action('expandView') ? ['expand'] : []), ...(view.canClose && action('closeView') ? ['close'] : [])];
                return `    - view_id: ${esc(view.viewId)} [${actions[0]}${actions.length > 1 ? '; ' + actions.slice(1).join(', ') : ''}]`;
            }) : []),
        ].join('\n');
    });
    const desktop = '<desktop>\n\n## Installed TUI Applications\n' +
        (directory.length ? directory.join('\n') : input.emptyCatalogText ?? '- No applications installed.') +
        (input.desktopSuffix === undefined ? '' : escapeXmlText(input.desktopSuffix)) + '\n\n</desktop>';
    return { views, desktop, instruction: input.compact || input.includeInstruction === false ? undefined : DEFAULT_AOTUI_SYSTEM_INSTRUCTION,
        appSelections, tools, issues, systemIssues, refs };
}

function systemTools(catalog: readonly CatalogEntry[], capabilities: readonly DesktopCapability[], hasRefs: boolean, strict: boolean): NativeTool[] {
    const available = new Set(capabilities);
    const has = (predicate: (entry: CatalogEntry) => boolean) => catalog.some(predicate);
    const live = ({ app }: CatalogEntry) => !!app.appId && !!app.appInstanceId;
    const running = (entry: CatalogEntry) => live(entry) && status(entry) === 'running';
    const viewExists = (predicate: (view: PresentedAppWindows['views'][number]) => boolean) =>
        has(entry => running(entry) && (entry.windows?.views.some(predicate) ?? false));
    const tools: NativeTool[] = [];
    const add = (action: DesktopCapability, description: string, properties: NativeTool['inputSchema'], required = Object.keys(properties)) => {
        if (available.has(action)) tools.push({ name: DESKTOP_TOOL_NAMES[action], description,
            inputSchema: { type: 'object', properties, required, additionalProperties: false } });
    };
    const app = { app_id: { type: 'string' } };
    const view = { ...app, view_id: { type: 'string' } };
    const note = { type: 'string', description: 'Note to show in place of the content. Use an empty string for no note.' };
    add('open', 'Start an application using its installation_id from the Desktop.', { installation_id: { type: 'string' } });
    add('close', 'Close the current application selected by app_id.', app);
    if (has(running)) add('collapse', 'Collapse an application. Keep an optional note in its place.',
        { ...app, note }, strict ? ['app_id', 'note'] : ['app_id']);
    if (has(entry => live(entry) && status(entry) === 'collapsed')) add('expand', 'Expand a collapsed application when the model budget allows it.', app);
    if (viewExists(view => view.expanded)) add('collapseView', 'Collapse an open View and optionally leave a note.',
        { ...view, note }, strict ? ['app_id', 'view_id', 'note'] : ['app_id', 'view_id']);
    if (viewExists(view => !view.expanded)) add('expandView', 'Expand a collapsed View when the model budget allows it.', view);
    if (viewExists(view => view.canClose)) add('closeView', 'Ask an independently closable View to close, including when collapsed.', view);
    if (hasRefs && available.has('inspectRef')) tools.push({ name: DESKTOP_TOOL_NAMES.inspectRef,
        description: 'Read a visible Ref’s declared schema or the original value of a public Ref.', inputSchema: inspectRefSchema });
    add('readWindowBudget', 'Read one page of the window budget report for this conversation.',
        { report_id: { type: 'string' }, page: { type: 'integer', ...(strict ? {} : { minimum: 1 }) } });
    return tools;
}

export function routeNativeInvocation(tools: readonly NativeTool[], name: string, input: unknown, invocationId: string):
    { status: 'ready'; invocation: AppInvocation & { appId: string; instanceId: string } } |
    { status: 'rejected'; issue: InteractionIssue } {
    const reject = (code: string, message: string, path?: string) =>
        ({ status: 'rejected' as const, issue: { code, message, ...(path === undefined ? {} : { path }) } });
    const route = tools.find(tool => tool.name === name)?.route;
    if (!route) return reject('TOOL_UNAVAILABLE', 'This Tool was not published in the original request.');
    if (input === null || typeof input !== 'object' || Array.isArray(input))
        return reject('INVOCATION_INVALID', 'Tool input must be an object.');
    const fields = Object.getOwnPropertyDescriptors(input);
    const receiver = Object.hasOwn(fields, 'view_id') ? fields.view_id : undefined;
    const viewId = receiver?.enumerable && Object.hasOwn(receiver, 'value') ? receiver.value : undefined;
    if (route.multiplicity === 'multiple' && (typeof viewId !== 'string' || !viewId) ||
        route.multiplicity === 'single' && receiver !== undefined)
        return reject('TOOL_INVALID_ARGS', route.multiplicity === 'multiple'
            ? 'Choose the receiving page with its string view_id ($.view_id).' : 'This single-instance tool takes no view_id ($.view_id).', '$.view_id');
    delete fields.view_id;
    const { appId, instanceId, observationId, toolId } = route;
    return { status: 'ready', invocation: { appId, instanceId, observationId, toolId, invocationId,
        ...(typeof viewId === 'string' ? { viewId } : {}), input: Object.defineProperties(Object.create(null), fields) } };
}
