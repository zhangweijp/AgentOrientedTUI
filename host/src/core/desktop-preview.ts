import type { AppDiscoveryInfo, IDesktop } from '@aotui/runtime';

export interface DesktopPreviewView {
    readonly id: string;
    readonly name: string;
    readonly content: string;
}

export interface DesktopPreviewApp {
    readonly installationId: string;
    readonly name: string;
    readonly status: AppDiscoveryInfo['status'];
    readonly run?: AppDiscoveryInfo['run'];
    readonly views: readonly DesktopPreviewView[];
}

export interface DesktopPreview {
    readonly applications: readonly DesktopPreviewApp[];
    readonly diagnostics: readonly string[];
}

export async function readDesktopPreview(desktop: IDesktop): Promise<DesktopPreview> {
    const applications: DesktopPreviewApp[] = [];
    const diagnostics: string[] = [];
    for (const { installationId, appId, appInstanceId, name, status, run } of desktop.listApps()) {
        const views: DesktopPreviewView[] = [];
        if (status === 'running' && appId && appInstanceId && (!run || run.phase === 'opened')) {
            try {
                const access = desktop.getRunningApp(appId, appInstanceId);
                const preview = access.status === 'ready' ? await access.app.preview() : access;
                if (preview.status === 'previewed') {
                    for (const view of preview.views) {
                        if (view.content) views.push({ id: view.id, name: view.name, content: view.content.value });
                    }
                } else {
                    const { code, message, path } = preview.issue;
                    diagnostics.push(`${name}: ${code}: ${message}${path ? ` (at ${path})` : ''}`);
                }
            } catch {
                diagnostics.push(`${name}: App projection unavailable.`);
            }
        }
        applications.push({ installationId, name, status, views, ...(run ? { run } : {}) });
    }
    return { applications, diagnostics };
}
