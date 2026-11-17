import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import { readDOMAppViews } from './dom-app.js';

function createContainer(markup: string): Element {
    const { document } = parseHTML('<html><body></body></html>');
    document.body.innerHTML = markup;
    return document.body;
}

function readViews(container: Element) {
    return readDOMAppViews(container, node => ({
        id: node.getAttribute('data-view-id')!,
        type: node.getAttribute('data-view-type')!,
        owner: node, bindings: [], refs: [],
    }));
}

function fragment(fragments: ReturnType<typeof readViews>, viewId: string) {
    return fragments.find(item => item.id === viewId)!;
}

describe('DOM View boundaries', () => {
    it('rejects data-view-id descendants at any depth with both View identities', () => {
        const container = createContainer(`
            <div data-view-id="parent_view_123" data-view-type="Parent" data-view-kind="state">
                <section>
                    <div data-view-id="child_view_1234" data-view-type="Child" data-view-kind="state">
                        <div data-view-id="grandchild" data-view-type="Grandchild" data-view-kind="state">Private content</div>
                    </div>
                </section>
            </div>
        `);

        let rejection: unknown;
        try {
            readViews(container);
        } catch (error) {
            rejection = error;
        }

        expect(rejection).toBeInstanceOf(Error);
        const message = (rejection as Error).message;
        expect(message).toContain('NESTED_VIEW_UNSUPPORTED');
        expect(message).toContain('child_view_1234');
        expect(message).toContain('parent_view_123');
        expect(message).toContain('Declare independent Views.');
        expect(message.length).toBeLessThanOrEqual(160);
    });

    it('accepts sibling Views and ordinary nested DOM within each View', () => {
        const container = createContainer(`
            <div data-view-id="parent" data-view-type="Parent" data-view-kind="state">
                <section><article>Ordinary parent content</article></section>
            </div>
            <div data-view-id="sibling" data-view-type="Sibling" data-view-kind="state">
                <section><article>Ordinary sibling content</article></section>
            </div>
        `);

        const fragments = readViews(container);

        expect(fragments.map(item => item.id).sort()).toEqual(['parent', 'sibling']);
        expect(fragment(fragments, 'parent').content.value).toContain('Ordinary parent content');
        expect(fragment(fragments, 'sibling').content.value).toContain('Ordinary sibling content');
    });

    it('keeps the repair hint within the diagnostic bound for arbitrary raw DOM IDs', () => {
        const parentId = 'p'.repeat(300);
        const childId = 'c'.repeat(300);
        const container = createContainer(`
            <div data-view-id="${parentId}" data-view-kind="state" data-view-type="FixtureView">
                <div data-view-id="${childId}" data-view-kind="state" data-view-type="FixtureView">Raw nested content</div>
            </div>
        `);

        let rejection: unknown;
        try {
            readViews(container);
        } catch (error) {
            rejection = error;
        }

        const message = (rejection as Error).message;
        expect(message).toContain(`${childId.slice(0, 25)}…`);
        expect(message).toContain(`${parentId.slice(0, 25)}…`);
        expect(message).toContain('Declare independent Views.');
        expect(message.endsWith('Declare independent Views.')).toBe(true);
        expect(message.length).toBeLessThanOrEqual(160);
    });

    it('preflights nested DOM before extracting any View and recovers after correction', () => {
        const container = createContainer(`
            <div data-view-id="parent" data-view-type="Parent" data-view-kind="state">Parent stable</div>
            <div data-view-id="sibling" data-view-type="Sibling" data-view-kind="state">Sibling stable</div>
        `);
        const first = readViews(container);
        const parent = container.querySelector('[data-view-id="parent"]')!;
        const sibling = container.querySelector('[data-view-id="sibling"]')!;
        parent.innerHTML = 'Parent invalid edit <div data-view-id="rogue" data-view-kind="state" data-view-type="FixtureView">RAW_NESTED_VIEW</div>';
        sibling.textContent = 'Sibling invalid edit';

        let rejection: unknown;
        try {
            readViews(container);
        } catch (error) {
            rejection = error;
        }
        expect((rejection as Error).message).toContain('rogue');
        expect((rejection as Error).message).toContain('parent');
        expect((rejection as Error).message).toContain('Declare independent Views.');

        parent.textContent = 'Parent stable';
        sibling.textContent = 'Sibling stable';
        const recovered = readViews(container);

        expect(fragment(first, 'parent').content.value).toBe('Parent stable');
        expect(fragment(first, 'sibling').content.value).toBe('Sibling stable');
        expect(fragment(recovered, 'parent').content.value).toBe('Parent stable');
        expect(fragment(recovered, 'sibling').content.value).toBe('Sibling stable');
    });
});
