import { readAppManifest, createRuntime, createDesktopId } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

const runtime = createRuntime();
try {
    const appDirectory = process.argv[2];
    if (!appDirectory) throw new Error('Pass the compiled Work Items App directory');
    const { metadata: { app_name: appName } } = await readAppManifest(appDirectory);
    const id = (await runtime.createDesktop(createDesktopId('demo'))).id;
    const desktop = runtime.getDesktop(id);
    const installationId = await desktop.registerPendingApp({ installationId: appName, localPath: appDirectory,
        config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR },
    });
    const appId = (await desktop.openApp(installationId)).appId;

    const source = new SemanticAOTUIDrivenSource(desktop);
    const inspect = `${appId}-Item-inspect`;
    const workspace = context => context.messages.find(({ content }) =>
        String(content).startsWith('<view view_id="workspace_1"') && String(content).includes(`app_name="${appName}"`));
    async function observe(ready) {
        const deadline = Date.now() + 5_000;
        do {
            const context = await source.getContext();
            if (ready(context)) return context;
            await context.release();
            await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        throw new Error(`Timed out observing ${appName}`);
    }
    try {
        const context = await observe(current => current.tools[inspect] && workspace(current));
        let receipt;
        try {
            await context.adopt();
            receipt = await context.executeTool(inspect, { view_id: 'billing_export_2026_11_1', selected: `$ref.${appId}.billing_export_2026_11_1.selected` }, 'inspect-1');
            if (receipt.outcomeStatus !== 'succeeded') throw new Error(`Inspection failed: ${JSON.stringify(receipt)}`);
        } finally {
            await context.release();
        }
        const next = await observe(current => String(workspace(current)?.content).includes('Inspections: 1'));
        try {
            await next.adopt();
            console.log(JSON.stringify({ receipt, workspace: workspace(next).content }));
        } finally {
            await next.release();
        }
    } finally {
        source.dispose();
    }
} finally {
    const report = await runtime.beginClose().completion;
    if (!report.resourcesReleased || !report.ok) throw new Error(`Runtime shutdown failed: ${JSON.stringify(report)}`);
}
