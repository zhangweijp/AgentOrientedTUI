import type { ObservedRef, ViewRegion } from '@aotui/core';
import { formatRefPath } from '@aotui/core/host';

/** XML 1.0 character domain; do not normalize legal business text. */
export class XmlPresentationError extends Error {
    readonly code = 'AOTUI_XML_UNSUPPORTED';
    constructor(readonly path: string, readonly appId?: string, readonly viewId?: string) {
        super('XML 1.0 cannot represent the selected field at ' + diagnosticXmlText(path) +
            (appId === undefined ? '' : ' (App ' + diagnosticXmlText(appId) +
                (viewId === undefined ? '' : ', View ' + diagnosticXmlText(viewId)) + ')'));
    }
}
function xmlCharacter(character: string): boolean {
    const n = character.codePointAt(0)!;
    return n === 9 || n === 10 || n === 13 || n >= 0x20 && n <= 0xd7ff ||
        n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff;
}
/** Only diagnostic text may replace unrepresentable characters by their escaped spelling. */
export function diagnosticXmlText(value: string): string {
    return Array.from(value, char => xmlCharacter(char) ? char : '\\u{' + char.codePointAt(0)!.toString(16) + '}').join('');
}
export function assertXmlText(value: string, path: string, appId?: string, viewId?: string): void {
    for (const char of value) if (!xmlCharacter(char)) throw new XmlPresentationError(path, appId, viewId);
}
export function escapeXmlText(value: string, path = '$'): string {
    assertXmlText(value, path);
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

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
    /** The Ref descriptions from this View's Observation. */
    refs?: readonly ObservedRef[];
}): string {
    const check = (value: string, path: string) => { assertXmlText(value, path, view.appId, view.viewId); return value; };
    const attrs = Object.entries({
        view_id: view.viewId, view_type: view.viewType,
        app_id: view.appId, app_name: view.appName, region: view.region,
    }).map(([name, value]) => `${name}="${escapeXmlText(check(value, '$.view.attributes.' + name)).replace(/"/g, '&quot;')
        .replace(/[\r\n\t]/g, char => `&#${char.charCodeAt(0)};`)}"`).join(' ');
    check(view.markup, '$.view.content');
    const references = view.refs?.map((ref, index) => {
        const address = '$ref.' + view.appId + '.' + view.viewId + formatRefPath([ref.refId]);
        return '- ' + check(ref.scope, '$.refs[' + index + '].scope') + ' ' + check(address, '$.refs[' + index + '].address') + ' (' +
            check(ref.refType, '$.refs[' + index + '].refType') + (ref.array ? '[]' : '') + ')';
    });
    const hints = references?.length ? '\n\nAvailable references\n' + references.join('\n') : '';
    return `<view ${attrs}>\n${escapeXmlText(view.markup + hints)}\n</view>`;
}
