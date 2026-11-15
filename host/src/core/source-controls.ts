import type { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import type { McpDrivenSource } from '../mcp/source.js';
import type { SkillDrivenSource } from '../skills/skill-driven-source.js';
import {
    appSourceControls,
    hasInvalidMcpToolKeys,
    isMcpItemKey,
    parseMcpServerItemKey,
} from '../shared/source-control-keys.js';

export type SourceControlsSnapshot = {
    apps: { enabled: boolean; disabledItems: string[] };
    mcp: { enabled: boolean; disabledItems: string[]; allowedServers?: string[] };
    skill: { enabled: boolean; disabledItems: string[] };
};

export function createDefaultSourceControls(): SourceControlsSnapshot {
    return {
        apps: { enabled: true, disabledItems: [] },
        mcp: { enabled: true, disabledItems: [] },
        skill: { enabled: true, disabledItems: [] },
    };
}

export function normalizeSourceControlsSnapshot(
    input?: Partial<SourceControlsSnapshot> | null,
): SourceControlsSnapshot {
    const defaults = createDefaultSourceControls();
    if (!input) {
        return defaults;
    }

    const normalizeBucket = (
        bucket: Partial<SourceControlsSnapshot['apps']> | undefined,
        fallback: SourceControlsSnapshot['apps'],
    ) => ({
        enabled: typeof bucket?.enabled === 'boolean' ? bucket.enabled : fallback.enabled,
        disabledItems: Array.isArray(bucket?.disabledItems)
            ? bucket.disabledItems.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : fallback.disabledItems,
    });

    const mcp: SourceControlsSnapshot['mcp'] = normalizeBucket(input.mcp, defaults.mcp);
    const disabled = input.mcp?.disabledItems;
    if (Array.isArray(disabled)) mcp.disabledItems = disabled.filter(key => typeof key === 'string');
    if (disabled !== undefined && (!Array.isArray(disabled) || disabled.some(key => !isMcpItemKey(key)))) {
        mcp.enabled = false;
    }

    const allowedServers = input.mcp?.allowedServers;
    if (allowedServers !== undefined) {
        const valid = Array.isArray(allowedServers)
            && allowedServers.every(name => typeof name === 'string' && name.trim().length > 0);
        mcp.allowedServers = valid ? [...new Set(allowedServers)] : [];
        if (!valid) mcp.enabled = false;
    }
    return {
        apps: normalizeBucket(input.apps, defaults.apps),
        mcp,
        skill: normalizeBucket(input.skill, defaults.skill),
    };
}

function getAgentMcpServers(agent?: { enabledMCPs?: unknown }): string[] {
    return Array.isArray(agent?.enabledMCPs)
        ? agent.enabledMCPs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
}

export function createSourceControlsFromAgent(
    agent: any,
    registeredApps: readonly string[],
): SourceControlsSnapshot {
    const enabledApps = Array.isArray(agent?.enabledApps)
        ? agent.enabledApps.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
    const enabledSkills = agent?.enabledSkills && typeof agent.enabledSkills === 'object'
        ? Object.values(agent.enabledSkills as Record<string, unknown>)
            .flatMap((bucket) => Array.isArray(bucket)
                ? bucket.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
                : [])
        : [];
    const allowedServers = getAgentMcpServers(agent);
    const invalidTools = hasInvalidMcpToolKeys(agent?.disabledMcpTools);
    const disabledToolKeys: string[] = Array.isArray(agent?.disabledMcpTools) ? agent.disabledMcpTools : [];

    return normalizeSourceControlsSnapshot({
        apps: appSourceControls(enabledApps, registeredApps),
        skill: {
            enabled: enabledSkills.length > 0,
            disabledItems: [],
        },
        mcp: {
            enabled: allowedServers.length > 0 && !invalidTools,
            allowedServers,
            disabledItems: [...new Set(disabledToolKeys)],
        },
    });
}

export function applySourceControlsToSources(
    controlsInput: SourceControlsSnapshot | undefined,
    options: {
        aotuiSource?: SemanticAOTUIDrivenSource;
        mcpSource?: McpDrivenSource;
        skillSource?: SkillDrivenSource;
    },
): SourceControlsSnapshot {
    const controls = normalizeSourceControlsSnapshot(controlsInput);

    const aotuiSource = options.aotuiSource;
    if (aotuiSource) {
        aotuiSource.setEnabled(controls.apps.enabled);
        controls.apps.disabledItems.forEach((item) => aotuiSource.setAppEnabled(item, false));
    }

    const mcpSource = options.mcpSource;
    if (mcpSource) {
        mcpSource.setEnabled(controls.mcp.enabled);
        for (const item of controls.mcp.disabledItems) {
            const server = parseMcpServerItemKey(item);
            if (server) mcpSource.setServerEnabled(server, false);
            else mcpSource.setToolEnabled(item, false);
        }
    }

    const skillSource = options.skillSource;
    if (skillSource) {
        skillSource.setEnabled(controls.skill.enabled);
        controls.skill.disabledItems.forEach((item) => skillSource.setSkillEnabled(item, false));
    }

    return controls;
}
