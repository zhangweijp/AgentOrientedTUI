import type { IDesktop, IKernel } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/runtime/adapters';

/** GUI inspection owns a separate short-lived observation; it cannot replace an in-flight Agent context. */
export async function readSemanticDesktopSnapshot(desktop: IDesktop, kernel: IKernel): Promise<{ markup: string }> {
    const source = new SemanticAOTUIDrivenSource(desktop, kernel, { includeInstruction: false });
    let context: Awaited<ReturnType<typeof source.getContext>> | undefined;
    try {
        const apps = source.listApps();
        context = await source.getContext();
        const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const views = new Map(apps.map(app => [escape(String(app.appId)), [] as string[]]));
        const desktopMessages: string[] = [];
        for (const message of context.messages) {
            const markup = typeof message.content === 'string' ? message.content
                : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
            if (/^\s*<desktop\b/.test(markup)) desktopMessages.push(markup);
            const attributes = /^\s*<view\b([^>]*)>/.exec(markup)?.[1];
            if (attributes === undefined) continue;
            const appId = /\bapp_id="([^"]+)"/.exec(attributes)?.[1];
            const group = appId === undefined ? undefined : views.get(appId);
            if (!group) throw new Error('Semantic preview View is missing a known app_id');
            group.push(markup);
        }
        // The GUI consumes application groups; Agent Messages remain independent Views.
        const applications = apps.map(app => `<application id="${escape(String(app.appId))}" name="${escape(app.name || String(app.appId))}" status="${app.status}">\n${views.get(escape(String(app.appId)))!.join('\n\n')}\n</application>`);
        return { markup: [...desktopMessages, ...applications].join('\n\n') };
    } finally {
        await context?.release?.();
        await source.dispose();
    }
}
