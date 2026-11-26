import type { ObservedRef, ViewRegion } from '@aotui/core';
import { formatRefPath } from '@aotui/core/host';

export const escapeXmlText = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');

export function collapsedWindowText(note: string): string {
    return note ? 'Collapsed · Agent note\n\n' + note : 'Collapsed';
}

/** Wrap a raw Markdown body and its current Ref addresses once. */
export function buildViewMessageMarkup(view: {
    appId: string;
    appName: string;
    viewId: string;
    viewType: string;
    region: ViewRegion;
    markup: string;
    suffix?: string;
    /** The Ref descriptions from this View's Observation. */
    refs?: readonly ObservedRef[];
}): string {
    const attrs = Object.entries({
        view_id: view.viewId, view_type: view.viewType,
        app_id: view.appId, app_name: view.appName, region: view.region,
    }).map(([name, value]) => `${name}="${escapeXmlText(value).replace(/"/g, '&quot;')
        .replace(/[\r\n\t]/g, char => `&#${char.charCodeAt(0)};`)}"`).join(' ');
    const references = view.refs?.map(ref => {
        const address = '$ref.' + view.appId + '.' + view.viewId + formatRefPath([ref.refId]);
        return '- ' + ref.scope + ' ' + address + ' (' + ref.refType + (ref.array ? '[]' : '') + ')';
    });
    const hints = references?.length ? '\n\nAvailable references\n' + references.join('\n') : '';
    return `<view ${attrs}>\n${escapeXmlText(view.markup + (view.suffix ?? '') + hints)}\n</view>`;
}
