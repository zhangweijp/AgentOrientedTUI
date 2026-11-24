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
export function buildPublicToolName(appName: string, ...parts: [toolName: string] | [viewType: string, toolName: string]): string {
    const invalid = (path: string, message: string): never => {
        throw Object.assign(new TypeError(`AOTUI_TOOL_NAME_INVALID: ${message}`), { code: 'AOTUI_TOOL_NAME_INVALID', path });
    };
    const fields: Array<[field: string, value: string]> = [['appName', appName]];
    if (parts.length === 2) fields.push(['viewType', parts[0]]);
    fields.push(['toolName', parts.length === 2 ? parts[1] : parts[0]]);
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

type ToolNames = Readonly<{ status: 'ready'; tools: ReadonlyMap<string, ObservedTool> }> |
    Readonly<{ status: 'rejected'; issue: InteractionIssue }>;

/** Name the complete observations before selecting individual receiving Views. */
export function projectNativeToolNames(observations: readonly Pick<Observation, 'source' | 'tools'>[]): readonly ToolNames[] {
    const ordered = observations.map((observation, index) => ({ observation, index }));
    ordered.sort(({ observation: a }, { observation: b }) => a.source.appId < b.source.appId ? -1 : a.source.appId > b.source.appId ? 1 : 0);
    const assigned = new Set<string>();
    const projected: ToolNames[] = new Array(observations.length);
    for (const { observation: { source: { appId }, tools }, index } of ordered) {
        try {
            const counts = new Map<string, number>();
            const named = new Map<string, ObservedTool>();
            for (const { name } of tools) counts.set(name, (counts.get(name) ?? 0) + 1);
            for (const tool of tools) {
                const qualify = (counts.get(tool.name) ?? 0) > 1 || reservedNames.has(`${appId}-${tool.name}`);
                const name = qualify ? buildPublicToolName(appId, tool.viewType, tool.name) : buildPublicToolName(appId, tool.name);
                if (named.has(name)) throw Object.assign(new Error(
                    `Public Tool alias ${JSON.stringify(name)} is declared more than once by this App. Rename its ViewType or Tool.`),
                { code: 'AOTUI_TOOL_NAME_COLLISION' });
                named.set(name, tool);
            }
            const conflict = [...named.keys()].find(name => assigned.has(name));
            if (conflict) throw Object.assign(new Error(
                `Public Tool alias ${JSON.stringify(conflict)} collides with another App. Rename this App, ViewType, or Tool.`),
            { code: 'AOTUI_TOOL_NAME_COLLISION' });
            for (const name of named.keys()) assigned.add(name);
            projected[index] = { status: 'ready', tools: named };
        } catch (cause) {
            if (!(cause instanceof Error) || !('code' in cause) || typeof cause.code !== 'string') throw cause;
            projected[index] = { status: 'rejected', issue: { code: cause.code, message: cause.message.replace(/^AOTUI_TOOL_NAME_INVALID:\s*/, ''),
                ...('path' in cause && typeof cause.path === 'string' ? { path: cause.path } : {}) } };
        }
    }
    return projected;
}
