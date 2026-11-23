import type { Observation, ObservedRef } from '@aotui/core';
import { formatRefPath } from '@aotui/core/internal';

export const escapeXmlText = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');

export function collapsedWindowText(note: string): string {
    return note ? 'Collapsed · Agent note\n\n' + note : 'Collapsed';
}

/** Wrap a raw Markdown body once. `presentedByApp` indexes the Views included in this request. */
export function buildViewMessageMarkup(view: {
    appId: string;
    appName: string;
    viewId: string;
    viewType: string;
    markup: string;
    suffix?: string;
    /** The Ref descriptions from this View's Observation. */
    refs?: readonly ObservedRef[];
}, presentedByApp?: ReadonlyMap<string, Pick<Observation, 'source' | 'views'>>): string {
    const attrs = Object.entries({
        view_id: view.viewId, view_type: view.viewType,
        app_id: view.appId, app_name: view.appName,
    }).map(([name, value]) => `${name}="${escapeXmlText(value).replace(/"/g, '&quot;')
        .replace(/[\r\n\t]/g, char => `&#${char.charCodeAt(0)};`)}"`).join(' ');
    const references = view.refs?.flatMap(ref => {
        const name = formatRefPath([ref.refId]);
        if (ref.paths === undefined)
            return [`- ${ref.scope} ${name.startsWith('.') ? name.slice(1) : name}: ${ref.refType}${ref.array ? '[]' : ''}`];
        const root = `$${view.appId}.${view.viewId}${name}`;
        return ref.paths.flatMap(({ path, consumer, refType, valueType, array }) => {
            if (consumer) {
                const target = presentedByApp?.get(consumer.appId);
                if (!target || target.source.appId !== consumer.appId || target.source.instanceId !== consumer.instanceId ||
                    !target.views.some(page => page.id === consumer.viewId && page.viewInstanceId === consumer.viewInstanceId)) return [];
            }
            const type = refType ? refType + (array ? '[]' : '') : valueType;
            const target = consumer ? ` for app_id ${consumer.appId}, view_id ${consumer.viewId}` : '';
            return [`- ${ref.scope} ${root}${formatRefPath(path)}${type ? ' (' + type + ')' : ''}${target}`];
        });
    });
    const hints = references?.length ? '\n\nAvailable references\n' + references.join('\n') : '';
    return `<view ${attrs}>\n${escapeXmlText(view.markup + (view.suffix ?? '') + hints)}\n</view>`;
}
