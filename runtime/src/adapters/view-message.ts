/** Normalize the existing DOM envelope or wrap a plain Producer body once. */
export function buildViewMessageMarkup(view: {
    appId?: string;
    appName?: string;
    viewId?: string;
    viewType?: string;
    viewName?: string;
    markup: string;
    suffix?: string;
}): string {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const attrs = Object.entries({
        id: view.viewId || 'unknown', type: view.viewType || 'Unknown',
        name: view.viewName || view.viewType || view.viewId || 'Unknown',
        app_id: view.appId || 'unknown', app_name: view.appName || 'unknown',
    }).map(([name, value]) => `${name}="${escape(value)}"`).join(' ');
    const raw = String(view.markup || '').trim();
    const envelope = /^<view\b[^>]*>([\s\S]*)<\/view>$/i.exec(raw);
    if (envelope) return `<view ${attrs}>${envelope[1]}${view.suffix || ''}</view>`;
    return `<view ${attrs}>\n${raw}${view.suffix || ''}\n</view>`;
}
