import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

import { extractViewFragments } from './view-fragment-extractor.js';

function createContainer(markup: string): Element {
    const { document } = parseHTML('<html><body></body></html>');
    document.body.innerHTML = markup;
    return document.body;
}

describe('extractViewFragments', () => {
    it('classifies application instruction fragments', () => {
        const container = createContainer('<div data-view-id="view_0" data-view-type="Workspace"><div data-role="application-instruction">Open the workspace</div></div>');

        expect(extractViewFragments(container)).toMatchObject([{
            viewId: 'view_0',
            viewType: 'Workspace',
            markup: 'Open the workspace',
            kind: 'application-instruction',
        }]);
    });

    it('classifies unmarked fragments as View state', () => {
        const container = createContainer('<div data-view-id="view_1" data-view-type="Detail"><span>Business content</span></div>');

        expect(extractViewFragments(container)).toMatchObject([{
            viewId: 'view_1',
            viewType: 'Detail',
            markup: 'Business content',
            kind: 'view-state',
        }]);
    });

    it('extracts the current content and classification on every capture', () => {
        const container = createContainer('<div data-view-id="view_2" data-view-type="Detail"><span>Before</span></div>');
        const first = extractViewFragments(container);
        container.querySelector('span')!.textContent = 'After';
        container.querySelector('span')!.setAttribute('data-role', 'application-instruction');
        const second = extractViewFragments(container);

        expect(first[0]).toMatchObject({ markup: 'Before', kind: 'view-state' });
        expect(second[0]).toMatchObject({ markup: 'After', kind: 'application-instruction' });
    });
});
