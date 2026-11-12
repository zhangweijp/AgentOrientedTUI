import type { IDesktop, IKernel } from '@aotui/runtime';
import { buildViewMessageMarkup } from '@aotui/runtime/adapters';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Refresh committed pages without preparing an executable observation. */
export async function readSemanticDesktopSnapshot(desktop: IDesktop, kernel: IKernel): Promise<{ markup: string }> {
    const diagnostics: string[] = [];
    const applications: string[] = [];
    for (const app of desktop.getInstalledApps()) {
        const appId = String(app.appId), name = app.name || appId;
        const views: string[] = [];
        if (app.status === 'running' && app.appInstanceId) {
            try {
                const access = kernel.getAppInteraction(desktop.id, appId, app.appInstanceId);
                const preview = access.status === 'ready' ? await access.interaction.preview() : access;
                if (preview.status === 'previewed') {
                    for (const view of preview.views) {
                        if (!view.content) continue;
                        views.push(buildViewMessageMarkup({ appId, appName: name, viewId: view.id, viewType: view.type,
                            viewName: view.name, kind: view.kind, markup: view.content.format === 'markdown-v1'
                                ? view.content.value : JSON.stringify(view.content.value) }));
                    }
                } else {
                    const { code, message, path } = preview.issue;
                    diagnostics.push(escape(`${name}: ${code}: ${message}${path ? ` (at ${path})` : ''}`));
                }
            } catch {
                diagnostics.push(escape(`${name}: App projection unavailable.`));
            }
        }
        applications.push(`<application id="${escape(appId)}" name="${escape(name)}" status="${app.status}">\n${views.join('\n\n')}\n</application>`);
    }
    const logs = desktop.getSystemLogs?.().slice(-5).map(log => escape(log.message)) ?? [];
    return { markup: [`<desktop>\n${[...diagnostics, ...logs].join('\n')}\n</desktop>`, ...applications].join('\n\n') };
}
