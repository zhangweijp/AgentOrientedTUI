import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import { createViewFragmentExtractor } from './view-fragment-extractor.js';

function createContainer(markup: string): Element {
    const { document } = parseHTML('<html><body></body></html>');
    document.body.innerHTML = markup;
    return document.body;
}

function fragment(fragments: ReturnType<ReturnType<typeof createViewFragmentExtractor>>, viewId: string) {
    return fragments.find(item => item.viewId === viewId)!;
}

describe('R2 View projection boundaries', () => {
    it('rejects data-view-id descendants at any depth with both View identities', () => {
        const extractor = createViewFragmentExtractor();
        const container = createContainer(`
            <div data-view-id="parent_view_123" data-view-type="Parent">
                <section>
                    <div data-view-id="child_view_1234" data-view-type="Child">
                        <div data-view-id="grandchild" data-view-type="Grandchild">Private content</div>
                    </div>
                </section>
            </div>
        `);

        let rejection: unknown;
        try {
            extractor(container, 'app' as never, 10);
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
        const extractor = createViewFragmentExtractor();
        const container = createContainer(`
            <div data-view-id="parent" data-view-type="Parent">
                <section><article>Ordinary parent content</article></section>
            </div>
            <div data-view-id="sibling" data-view-type="Sibling">
                <section><article>Ordinary sibling content</article></section>
            </div>
        `);

        const fragments = extractor(container, 'app' as never, 10);

        expect(fragments.map(item => item.viewId).sort()).toEqual(['parent', 'sibling']);
        expect(fragment(fragments, 'parent').markup).toContain('Ordinary parent content');
        expect(fragment(fragments, 'sibling').markup).toContain('Ordinary sibling content');
    });

    it('keeps the repair hint within the diagnostic bound for arbitrary raw DOM IDs', () => {
        const extractor = createViewFragmentExtractor();
        const parentId = 'p'.repeat(300);
        const childId = 'c'.repeat(300);
        const container = createContainer(`
            <div data-view-id="${parentId}">
                <div data-view-id="${childId}">Raw nested content</div>
            </div>
        `);

        let rejection: unknown;
        try {
            extractor(container, 'app' as never, 10);
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

    it('preflights the whole DOM before digest caches change on an invalid projection', () => {
        const extractor = createViewFragmentExtractor();
        const container = createContainer(`
            <div data-view-id="parent" data-view-type="Parent">Parent stable</div>
            <div data-view-id="sibling" data-view-type="Sibling">Sibling stable</div>
        `);
        const first = extractor(container, 'app' as never, 10);
        const parent = container.querySelector('[data-view-id="parent"]')!;
        const sibling = container.querySelector('[data-view-id="sibling"]')!;
        parent.innerHTML = 'Parent invalid edit <div data-view-id="rogue">RAW_NESTED_VIEW</div>';
        sibling.textContent = 'Sibling invalid edit';

        let rejection: unknown;
        try {
            extractor(container, 'app' as never, 15);
        } catch (error) {
            rejection = error;
        }
        expect((rejection as Error).message).toContain('rogue');
        expect((rejection as Error).message).toContain('parent');
        expect((rejection as Error).message).toContain('Declare independent Views.');

        parent.textContent = 'Parent stable';
        sibling.textContent = 'Sibling stable';
        const recovered = extractor(container, 'app' as never, 20);

        expect(fragment(recovered, 'parent')).toMatchObject({
            markup: fragment(first, 'parent').markup,
            timestamp: 10,
        });
        expect(fragment(recovered, 'sibling')).toMatchObject({
            markup: fragment(first, 'sibling').markup,
            timestamp: 10,
        });
    });
});
