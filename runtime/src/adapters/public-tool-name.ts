import type { InteractionIssue, Observation, ObservedTool } from '@aotui/core';

export const DESKTOP_TOOL_NAMES = Object.freeze({
    open: 'system-open_app',
    close: 'system-close_app',
    collapse: 'system-collapse_app',
    expand: 'system-expand_app',
    collapseView: 'system-collapse_view',
    expandView: 'system-expand_view',
    closeView: 'system-close_view',
    inspectRef: 'system-inspect_ref',
    readWindowBudget: 'system-read_window_budget',
} as const);

const reservedNames = new Set<string>(Object.values(DESKTOP_TOOL_NAMES));

/** Validate and join the fields used in a native Tool alias. */
export function buildPublicToolName(appName: string, viewType: string, toolName: string): string {
    const invalid = (path: string, message: string): never => {
        throw Object.assign(new TypeError(`AOTUI_TOOL_NAME_INVALID: ${message}`), { code: 'AOTUI_TOOL_NAME_INVALID', path });
    };
    const fields = [['appName', appName], ['viewType', viewType], ['toolName', toolName]] as const;
    for (const [field, part] of fields) {
        if (typeof part !== 'string' || !part.length) {
            invalid(field, `${field} must be a non-empty string. Use ASCII letters, digits, and underscores.`);
        }
        if (!/^[A-Za-z0-9_]+$/.test(part)) {
            invalid(field, `${field} must use only ASCII letters, digits, and underscores. Replace hyphens or other separators with underscores.`);
        }
    }
    const name = fields.map(([, value]) => value).join('-');
    if (name.length > 64) invalid('publicToolName', `the combined native Tool name has ${name.length} characters; shorten one or more fields to stay within 64.`);
    return name;
}

type ToolNameIssue = InteractionIssue & { readonly toolId?: string };
type ToolNames = Readonly<{ status: 'ready'; tools: ReadonlyMap<string, ObservedTool>; excluded: readonly (ToolNameIssue & { readonly toolId: string })[] }> |
    Readonly<{ status: 'rejected'; issue: ToolNameIssue }>;

/** Name each actual App namespace; a contradictory namespace never gets a winner. */
export function projectNativeToolNames(observations: readonly Pick<Observation, 'source' | 'tools'>[]): readonly ToolNames[] {
    const namespaces = new Map<string, number>();
    for (const { source: { appId } } of observations) namespaces.set(appId, (namespaces.get(appId) ?? 0) + 1);
    const collision = (message: string, toolId?: string): ToolNames => ({ status: 'rejected',
        issue: { code: 'AOTUI_TOOL_NAME_COLLISION', path: 'publicToolName', message, ...(toolId === undefined ? {} : { toolId }) } });
    return observations.map(({ source: { appId }, tools }) => {
        if (namespaces.get(appId)! > 1) return collision('More than one observation claims the same App namespace.', tools[0]?.id);
        const named = new Map<string, ObservedTool>();
        const identities = new Set<string>();
        const excluded: (ToolNameIssue & { readonly toolId: string })[] = [];
        for (const tool of tools) {
            if (identities.has(tool.id)) return collision('One original Tool identity claims more than one route.', tool.id);
            identities.add(tool.id);
            let name: string;
            try { name = buildPublicToolName(appId, tool.viewType, tool.name); }
            catch (cause) {
                if (!(cause instanceof Error) || !('code' in cause) || typeof cause.code !== 'string') throw cause;
                const issue = { code: cause.code, toolId: tool.id,
                    message: cause.message.replace(/^AOTUI_TOOL_NAME_INVALID:\s*/, ''),
                    ...('path' in cause && typeof cause.path === 'string' ? { path: cause.path } : {}) };
                if (issue.path === 'appName') return { status: 'rejected', issue };
                excluded.push(issue);
                continue;
            }
            if (named.has(name) || reservedNames.has(name))
                return collision('Public Tool name ' + JSON.stringify(name) + ' has more than one route.', tool.id);
            named.set(name, tool);
        }
        return { status: 'ready', tools: named, excluded };
    });
}
