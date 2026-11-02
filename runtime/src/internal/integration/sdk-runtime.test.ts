/**
 * Semantic view HTML is rendered as content. Current Tool definitions and
 * navigation remain owned by the Semantic contracts, not legacy DOM markers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { transformElement } from '../../engine/view/transformer/pure.js';

describe('Semantic view HTML projection', () => {
    it('preserves normal HTML and Markdown content in a View', () => {
        const { document } = parseHTML(`<!DOCTYPE html><html><body>
            <div id="view_0" view="Conversations">
                <h2>Conversations</h2>
                <p>Welcome to <strong>AOTUI Chat</strong>.</p>
                <blockquote>Use <code>read_file</code> to open a file.</blockquote>
                <ul><li>First message</li><li>Second message</li></ul>
                <a href="https://example.com">Documentation</a>
            </div>
        </body></html>`);
        const { markup } = transformElement(document.body);

        expect(markup).toContain('<view id="view_0" name="Conversations">');
        expect(markup).toContain('## Conversations');
        expect(markup).toContain('**AOTUI Chat**');
        expect(markup).toContain('`read_file`');
        expect(markup).toContain('First message');
        expect(markup).toContain('Second message');
        expect(markup).toContain('[Documentation](https://example.com)');
    });

    it('keeps display text without interpreting retired operation or ViewLink attributes', () => {
        const { document } = parseHTML(`<!DOCTYPE html><html><body>
            <div id="view_0" view="Detail">
                <button operation="edit_file" desc="Edit this file">Edit file</button>
                <a view-target="Other" desc="Open another view">Other view</a>
            </div>
        </body></html>`);
        const { markup } = transformElement(document.body);

        expect(markup).toContain('Edit file');
        expect(markup).toContain('Other view');
        expect(markup).not.toContain('(tool:edit_file)');
        expect(markup).not.toContain('(view:Other)');
    });

    it('demo app root views preserve the application instruction contract', () => {
        const demoRootViews = [
            '../../../../demo-apps/planning-app/src/tui/RootView.tsx',
            '../../../../demo-apps/lite-browser-app/src/tui/RootView.tsx',
            '../../../../demo-apps/token-monitor-app/src/tui/RootView.tsx',
            '../../../../demo-apps/terminal-app/src/tui/RootView.tsx',
        ];

        for (const relativePath of demoRootViews) {
            const source = readFileSync(new URL(relativePath, import.meta.url), 'utf-8');
            expect(source).toContain('data-role="application-instruction"');
            expect(source).toContain('What it is');
            expect(source).toContain('How to use');
            expect(source).toContain('Views');
            expect(source).toContain('Tool Preconditions');
            expect(source).not.toContain('Current State');
        }
    });
});
