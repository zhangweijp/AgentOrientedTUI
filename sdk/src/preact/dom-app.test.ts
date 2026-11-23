import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

import { readDOMAppViews } from './dom-app.js';
import { buildViewMessageMarkup } from '../../../runtime/src/adapters/view-message.js';

function createContainer(markup: string): Element {
    const { document } = parseHTML('<html><body></body></html>');
    document.body.innerHTML = markup;
    return document.body;
}

function readViews(container: Element) {
    return readDOMAppViews(container, node => ({
        id: node.getAttribute('data-view-id')!, name: node.getAttribute('data-view-id')!,
        region: node.getAttribute('data-fixture-region') === 'static' ? 'static' : 'dynamic',
        type: node.getAttribute('data-aotui-view')!,
        owner: node, bindings: [], refs: [],
    }));
}

describe('DOM adapter', () => {
    it.each([
        ['no children', '', ''],
        ['whitespace-only text', ' \n  \t', ' \n  \t'],
        ['whitespace inside an inline element', '<span> \n  \t</span>', ' \n  \t'],
    ])('retains a registered View with %s', (_label, children, value) => {
        const container = createContainer(`<div data-view-id="empty" data-aotui-view="EmptyType">${children}</div>`);

        expect(readViews(container)).toMatchObject([{
            id: 'empty',
            type: 'EmptyType',
            name: 'empty',
            content: { value },
            region: 'dynamic',
        }]);
    });

    it('reads explicit instruction metadata', () => {
        const container = createContainer('<div data-view-id="view_0" data-aotui-view="Workspace" data-fixture-region="static"><div data-role="application-instruction">Open the workspace</div></div>');

        expect(readViews(container)).toMatchObject([{
            id: 'view_0',
            type: 'Workspace',
            content: { value: 'Open the workspace' },
            region: 'static',
        }]);
    });

    it('reads explicit state metadata', () => {
        const container = createContainer('<div data-view-id="view_1" data-aotui-view="Detail"><span>Business content</span></div>');

        expect(readViews(container)).toMatchObject([{
            id: 'view_1',
            type: 'Detail',
            content: { value: 'Business content' },
            region: 'dynamic',
        }]);
    });

    it('updates content without letting descendant roles change classification', () => {
        const container = createContainer('<div data-view-id="view_2" data-aotui-view="Detail"><span>Before</span></div>');
        const first = readViews(container);
        container.querySelector('span')!.textContent = 'After';
        container.querySelector('span')!.setAttribute('data-role', 'application-instruction');
        const second = readViews(container);

        expect(first[0]).toMatchObject({ content: { value: 'Before' }, region: 'dynamic' });
        expect(second[0]).toMatchObject({ content: { value: 'After' }, region: 'dynamic' });
    });

    it('preserves code whitespace and chooses a fence that cannot close on body backticks', () => {
        const container = createContainer('<div data-view-id="file" data-aotui-view="File"></div>');
        const view = container.querySelector('[data-view-id="file"]')!;
        const pre = container.ownerDocument!.createElement('pre');
        const code = container.ownerDocument!.createElement('code');
        const codeBody = '    first line  \n```\nlast line    \n';
        code.textContent = codeBody;
        pre.appendChild(code);
        view.appendChild(pre);

        const [fragment] = readViews(container);

        expect(fragment!.content.value).toContain('\n````\n' + codeBody + '````\n');
        expect(fragment!.content.value.match(/\n    first line  \n```\nlast line    \n/)).not.toBeNull();
    });

    it('keeps literal View-like body text separate from View metadata', () => {
        const container = createContainer('<div data-view-id="file" data-aotui-view="File" data-view-name="foo&gt;bar" view="foo&gt;bar"></div>');
        const view = container.querySelector('[data-view-id="file"]')!;
        const paragraph = container.ownerDocument!.createElement('p');
        const literalBody = '<view id="literal">body from file</view>';
        paragraph.textContent = literalBody;
        view.appendChild(paragraph);

        const [fragment] = readViews(container);
        const message = buildViewMessageMarkup({
            appId: 'ide', appName: 'IDE', viewId: fragment!.id, viewType: fragment!.type,
            markup: fragment!.content.value,
        });

        expect(fragment!.content.value).toContain(literalBody);
        expect(fragment!.content.value).not.toContain('bar">');
        expect(message).toContain('view_id="file" view_type="File"');
        expect(message).toContain('&lt;view id="literal"&gt;body from file&lt;/view&gt;');
        expect(message.match(/<view\b/g)).toHaveLength(1);
        expect(message.match(/<\/view>/g)).toHaveLength(1);
        expect(message).not.toContain('bar">');
    });
});


it('uses attachment metadata independently of DOM roles and data attributes', () => {
    const container = createContainer('<div data-aotui-view="Detail" data-region="static"><p data-role="application-instruction">Before</p></div>');
    const views = readDOMAppViews(container, node => ({
        id: 'detail', name: 'Attachment name', type: 'Detail', region: 'dynamic', refs: [], bindings: [], owner: node,
    }));
    expect(views[0]).toMatchObject({ region: 'dynamic', type: 'Detail', id: 'detail', name: 'Attachment name' });
});

it('preserves inline code edge spaces and backticks through actual DOM projection', () => {
    const container = createContainer('<div data-view-id="code" data-aotui-view="Code"><code></code></div>');
    container.querySelector('code')!.textContent = '  `quoted`  ';
    expect(readViews(container)[0]!.content.value).toBe('``   `quoted`   ``');
});
