import assert from 'node:assert/strict';

const envelope = /^<view view_id="([A-Za-z0-9_]+)" view_type="([A-Za-z0-9_]+)" app_id="([A-Za-z0-9_]+)" app_name="([A-Za-z0-9_]+)">\n/;

export function modelViews<Message extends { role: string; content: unknown }>(messages: readonly Message[]) {
    return messages.flatMap(message => {
        if (typeof message.content !== 'string' || !message.content.startsWith('<view ')) return [];
        assert.equal(message.role, 'user');
        const identity = envelope.exec(message.content);
        assert.ok(identity && message.content.endsWith('\n</view>'), 'Expected the four-attribute model View envelope');
        assert.equal(message.content.match(/<view\b/g)?.length, 1);
        const [, id, type, appId, appName] = identity;
        return [{ id, type, appId, appName, markup: message.content, message }];
    });
}
