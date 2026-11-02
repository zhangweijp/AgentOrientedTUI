import type { Info, TuiAppConfigEntry } from './config.js';

/** One-time, explicit configuration migration. Topic overrides are deliberately untouched. */
export function migrateAgentAppReferences(
    config: Info,
    registeredApps: Record<string, TuiAppConfigEntry>,
    renames: Record<string, string>,
) {
    for (const [from, to] of Object.entries(renames)) {
        if (typeof to !== 'string' || !Object.hasOwn(registeredApps, to)) {
            throw new Error(`APP_REFERENCE_MIGRATION: target ${String(to)} is not registered`);
        }
        if (from !== to && Object.hasOwn(registeredApps, from)) {
            throw new Error(`APP_REFERENCE_MIGRATION: ${from} is still registered; refusing to merge distinct apps`);
        }
    }
    const changes: Array<{ agentId: string; from: string; to: string }> = [];
    const list = config.agents?.list.map(agent => {
        const enabledApps = agent.enabledApps.map(name => {
            const target = Object.hasOwn(renames, name) ? renames[name] : name;
            if (target !== name) changes.push({ agentId: agent.id, from: name, to: target });
            return target;
        });
        return { ...agent, enabledApps: [...new Set(enabledApps)] };
    });
    return {
        config: changes.length && config.agents ? { ...config, agents: { ...config.agents, list: list! } } : config,
        changes,
    };
}
