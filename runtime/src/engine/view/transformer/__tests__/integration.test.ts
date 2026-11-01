import { transformElement } from '../pure';
import { createMockElement } from './visitors/test-utils';
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

describe('Transformer Integration', () => {
    it('transforms a complete ChatView structure', () => {
        const html = `
        <div data-app-id="chat-app" name="Chat App">
            <div view="chat-view" id="chat-view">
                <h1>Chat History</h1>
                <ul><li>Hello</li><li>World</li></ul>
                <button operation="send_message" desc="Send a text">Send Message</button>
                <a view-target="settings" desc="Go to Settings">Settings</a>
            </div>
        </div>`;

        const el = createMockElement(html);
        const result = transformElement(el);

        const m = result.markup;

        // View
        expect(m).toContain('<view id="chat-view" name="chat-view">');

        // Header (HTML)
        expect(m).toContain('# Chat History');

        expect(m).toContain('Hello');
        expect(m).toContain('World');
        expect(m).toContain('Send Message');
        expect(m).toContain('Settings');
        expect(m).not.toContain('(tool:send_message)');
        expect(m).not.toContain('(view:settings)');
        expect(m).not.toContain('<application');
    });

    it('passes ordinary wrapper content while preserving sibling View markup', () => {
        const html = `
        <div data-app-id="app1">
            <div view="v1" id="v1">
                <p>First view text</p>
            </div>
            <div view="v2" id="v2">
                <p>Second view text</p>
            </div>
        </div>
        `;

        const el = createMockElement(html);
        const result = transformElement(el);

        expect(result.markup).toContain('First view text');
        expect(result.markup).toContain('Second view text');
        expect(result.markup).not.toContain('<application');
    });
});
