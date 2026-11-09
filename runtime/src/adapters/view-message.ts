import type { ViewSnapshotV2 } from '../core/snapshot/types.js';

/** XML text encoding happens once here; Producers supply an unwrapped Markdown body. */
export function buildViewMessageMarkup(view: {
    appId: string;
    appName: string;
    viewId: string;
    viewType: string;
    kind: ViewSnapshotV2['kind'];
    viewName?: string;
    markup: string;
    suffix?: string;
}): string {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
    const attrs = Object.entries({
        id: view.viewId, type: view.viewType, kind: view.kind,
        name: view.viewName ?? view.viewType,
        app_id: view.appId, app_name: view.appName,
    }).map(([name, value]) => `${name}="${escape(value).replace(/"/g, '&quot;')
        .replace(/[\r\n\t]/g, char => `&#${char.charCodeAt(0)};`)}"`).join(' ');
    return `<view ${attrs}>\n${escape(view.markup + (view.suffix ?? ''))}\n</view>`;
}
