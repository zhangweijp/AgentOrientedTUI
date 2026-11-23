// @vitest-environment node
/**
 * Semantic view HTML is rendered as content. Current Tool definitions and
 * navigation remain owned by the Semantic contracts, not legacy DOM markers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { transformElement } from './pure.js';

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
        const markup = transformElement(document.body);

        expect(markup).not.toContain('<view');
        expect(markup).toContain('## Conversations');
        expect(markup).toContain('**AOTUI Chat**');
        expect(markup).toContain('`read_file`');
        expect(markup).toContain('First message');
        expect(markup).toContain('Second message');
        expect(markup).toContain('[Documentation](https://example.com)');
    });

    it('keeps display text without interpreting retired action-marker or ViewLink attributes', () => {
        const { document } = parseHTML(`<!DOCTYPE html><html><body>
            <div id="view_0" view="Detail">
                <button data-action="edit_file" desc="Edit this file">Edit file</button>
                <a view-target="Other" desc="Open another view">Other view</a>
            </div>
        </body></html>`);
        const markup = transformElement(document.body);

        expect(markup).toContain('Edit file');
        expect(markup).toContain('Other view');
        expect(markup).not.toContain('(tool:edit_file)');
        expect(markup).not.toContain('(view:Other)');
    });

    it('demo app root views preserve the application instruction contract', () => {
        const demos = fileURLToPath(new URL('../../../../demo-apps/', import.meta.url));
        const demoRootViews = [
            'planning-app/src/tui/RootView.tsx',
            'lite-browser-app/src/tui/RootView.tsx',
            'terminal-app/src/tui/RootView.tsx',
        ];

        for (const [app, component, declaration] of [
            ['planning-app', 'PlanningApp.tsx', 'planning-tools.ts'],
            ['lite-browser-app', 'LiteBrowserApp.tsx', 'BrowserTools.tsx'],
            ['terminal-app', 'TerminalApp.tsx', 'TerminalTools.tsx'],
            ['aotui-ide', 'ScopedIDEApp.tsx', 'ide-tool-contracts.ts'],
        ]) {
            const base = join(demos, app, 'src/tui');
            const source = readFileSync(join(base, component), 'utf-8');
            const tools = readFileSync(join(base, declaration), 'utf-8');
            expect(source).toMatch(/<RootType id=['"]root['"]/);
            expect(tools).toMatch(/const RootType = defineViewType[^\n]*region: 'static'/);
        }

        for (const relativePath of demoRootViews) {
            const source = readFileSync(join(demos, relativePath), 'utf-8');
            expect(source).toContain('What it is');
            expect(source).toContain('How to use');
            expect(source).toContain('Views');
            expect(source).not.toContain('Current State');
        }
    });
});
