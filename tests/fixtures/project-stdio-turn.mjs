import { readFileSync } from 'node:fs';
import { projectDesktop } from '@aotui/runtime/adapters';

const { observation, plan, entry, live, appLayout } = JSON.parse(readFileSync(0, 'utf8'));
const windows = new Map(appLayout.views.map(({ viewInstanceId, ...layout }) => [viewInstanceId, layout]));
const projected = projectDesktop({
    apps: [{ observation, windows }],
    catalog: [{
        app: entry,
        ...(appLayout.note === undefined ? {} : { note: appLayout.note }),
        windows: {
            ...live,
            expanded: !appLayout.collapsed,
            views: live.views.map(view => ({
                ...view,
                expanded: windows.get(view.viewInstanceId)?.kind !== 'collapsed',
            })),
        },
    }],
    capabilities: plan.capabilities,
    strict: plan.strict === true,
});
process.stdout.write(JSON.stringify({
    views: projected.views,
    desktop: projected.desktop,
    instruction: projected.instruction,
    tools: projected.tools.map(({ name, description, inputSchema: schema, route }) => ({
        name, description, schema, ...(route && { toolId: route.toolId, observationId: route.observationId }),
    })),
    apps: projected.appSelections.map(({ observationId: candidate, windows }) => ({ candidate, windows })),
    issues: projected.issues,
}));
