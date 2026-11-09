import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

import { extractViewFragments } from './view-fragment-extractor.js';
import { buildViewMessageMarkup } from '../adapters/view-message.js';

function createContainer(markup: string): Element {
    const { document } = parseHTML('<html><body></body></html>');
    document.body.innerHTML = markup;
    return document.body;
}

describe('extractViewFragments', () => {
    it.each([
        ['no children', ''],
        ['whitespace-only children', '<span> \n  \t</span>'],
        ['all hidden children', '<span data-state="hidden">not projected</span>'],
    ])('retains a registered View with %s as an empty body', (_label, children) => {
        const container = createContainer(`<div data-view-id="empty" data-view-type="EmptyType" data-view-kind="state">${children}</div>`);

        expect(extractViewFragments(container)).toEqual([{
            viewId: 'empty',
            viewType: 'EmptyType',
            viewName: undefined,
            markup: '',
            kind: 'state',
        }]);
    });

    it('reads explicit instruction metadata', () => {
        const container = createContainer('<div data-view-id="view_0" data-view-type="Workspace" data-view-kind="instruction"><div data-role="application-instruction">Open the workspace</div></div>');

        expect(extractViewFragments(container)).toMatchObject([{
            viewId: 'view_0',
            viewType: 'Workspace',
            markup: 'Open the workspace',
            kind: 'instruction',
        }]);
    });

    it('reads explicit state metadata', () => {
        const container = createContainer('<div data-view-id="view_1" data-view-type="Detail" data-view-kind="state"><span>Business content</span></div>');

        expect(extractViewFragments(container)).toMatchObject([{
            viewId: 'view_1',
            viewType: 'Detail',
            markup: 'Business content',
            kind: 'state',
        }]);
    });

    it('updates content without letting descendant roles change classification', () => {
        const container = createContainer('<div data-view-id="view_2" data-view-type="Detail" data-view-kind="state"><span>Before</span></div>');
        const first = extractViewFragments(container);
        container.querySelector('span')!.textContent = 'After';
        container.querySelector('span')!.setAttribute('data-role', 'application-instruction');
        const second = extractViewFragments(container);

        expect(first[0]).toMatchObject({ markup: 'Before', kind: 'state' });
        expect(second[0]).toMatchObject({ markup: 'After', kind: 'state' });
    });

    it('preserves code whitespace and chooses a fence that cannot close on body backticks', () => {
        const container = createContainer('<div data-view-id="file" data-view-type="File" data-view-kind="state"></div>');
        const view = container.querySelector('[data-view-id="file"]')!;
        const pre = container.ownerDocument!.createElement('pre');
        const code = container.ownerDocument!.createElement('code');
        const codeBody = '    first line  \n```\nlast line    \n';
        code.textContent = codeBody;
        pre.appendChild(code);
        view.appendChild(pre);

        const [fragment] = extractViewFragments(container);

        expect(fragment!.markup).toContain('\n````\n' + codeBody + '````\n');
        expect(fragment!.markup.match(/\n    first line  \n```\nlast line    \n/)).not.toBeNull();
    });

    it('keeps literal View-like body text separate from View metadata', () => {
        const container = createContainer('<div data-view-id="file" data-view-type="File" data-view-name="foo&gt;bar" view="foo&gt;bar" data-view-kind="state"></div>');
        const view = container.querySelector('[data-view-id="file"]')!;
        const paragraph = container.ownerDocument!.createElement('p');
        const literalBody = '<view id="literal">body from file</view>';
        paragraph.textContent = literalBody;
        view.appendChild(paragraph);

        const [fragment] = extractViewFragments(container);
        const message = buildViewMessageMarkup({
            appId: 'ide', appName: 'IDE', viewId: fragment!.viewId, viewType: fragment!.viewType,
            viewName: fragment!.viewName, kind: fragment!.kind, markup: fragment!.markup,
        });

        expect(fragment!.markup).toContain(literalBody);
        expect(fragment!.markup).not.toContain('bar">');
        expect(message).toContain('name="foo&gt;bar"');
        expect(message).toContain('&lt;view id="literal"&gt;body from file&lt;/view&gt;');
        expect(message.match(/<view\b/g)).toHaveLength(1);
        expect(message.match(/<\/view>/g)).toHaveLength(1);
        expect(message).not.toContain('bar">');
    });
});


describe('explicit View metadata contract', () => {
    it('uses only root kind metadata and never a descendant role marker', () => {
        const container = createContainer('<div data-view-id="detail" data-view-type="Detail" data-view-kind="state"><p data-role="application-instruction">Before</p></div>');
        expect(extractViewFragments(container)[0]).toMatchObject({ kind: 'state', viewType: 'Detail' });
        container.querySelector('p')!.removeAttribute('data-role');
        expect(extractViewFragments(container)[0]!.kind).toBe('state');
        container.querySelector('[data-view-id]')!.setAttribute('data-view-kind', 'instruction');
        expect(extractViewFragments(container)[0]!.kind).toBe('instruction');
    });

    it.each([
        'data-view-kind="state"',
        'data-view-type="Detail"',
        'data-view-type="Detail" data-view-kind="other"',
    ])('rejects incomplete or invalid metadata instead of deriving it: %s', attributes => {
        const container = createContainer(`<div data-view-id="detail" ${attributes}>Body</div>`);
        expect(() => extractViewFragments(container)).toThrow(/VIEW_METADATA_INVALID/);
    });
});


it('preserves inline code edge spaces and backticks through actual DOM projection', () => {
    const container = createContainer('<div data-view-id="code" data-view-type="Code" data-view-kind="state"><code></code></div>');
    container.querySelector('code')!.textContent = '  `quoted`  ';
    expect(extractViewFragments(container)[0]!.markup).toBe('``   `quoted`   ``');
});
