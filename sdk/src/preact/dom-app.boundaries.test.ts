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
        id: node.getAttribute('data-view-id')!, name: node.getAttribute('data-view-id')!,
        region: node.getAttribute('data-fixture-region') === 'static' ? 'static' : 'dynamic',
        type: node.getAttribute('data-aotui-view')!,
        owner: node, bindings: [], refs: [],
    }), container.querySelectorAll('[data-aotui-view]').length);
}

function fragment(fragments: ReturnType<typeof readViews>, viewId: string) {
    return fragments.find(item => item.id === viewId)!;
}

describe('DOM View boundaries', () => {
    it('rejects marked View descendants at any depth with both View identities', () => {
        const container = createContainer(`
            <div data-view-id="parent_view_123" data-aotui-view="Parent">
                <section>
                    <div data-view-id="child_view_1234" data-aotui-view="Child">
                        <div data-view-id="grandchild" data-aotui-view="Grandchild">Private content</div>
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
        expect(message).toContain('Child');
        expect(message).toContain('Parent');
        expect(message).toContain('Declare independent Views.');
        expect(message.length).toBeLessThanOrEqual(160);
    });

    it('accepts sibling Views and ordinary nested DOM within each View', () => {
        const container = createContainer(`
            <div data-view-id="parent" data-aotui-view="Parent">
                <section><article>Ordinary parent content</article></section>
            </div>
            <div data-view-id="sibling" data-aotui-view="Sibling">
                <section><article>Ordinary sibling content</article></section>
            </div>
        `);

        const fragments = readViews(container);

        expect(fragments.map(item => item.id).sort()).toEqual(['parent', 'sibling']);
        expect(fragment(fragments, 'parent').content.value).toContain('Ordinary parent content');
        expect(fragment(fragments, 'sibling').content.value).toContain('Ordinary sibling content');
    });

    it('keeps the repair hint within the diagnostic bound for arbitrary raw DOM markers', () => {
        const parentId = 'p'.repeat(300);
        const childId = 'c'.repeat(300);
        const container = createContainer(`
            <div data-view-id="${parentId}" data-aotui-view="${parentId}">
                <div data-view-id="${childId}" data-aotui-view="${childId}">Raw nested content</div>
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
            <div data-view-id="parent" data-aotui-view="Parent">Parent stable</div>
            <div data-view-id="sibling" data-aotui-view="Sibling">Sibling stable</div>
        `);
        const first = readViews(container);
        const parent = container.querySelector('[data-view-id="parent"]')!;
        const sibling = container.querySelector('[data-view-id="sibling"]')!;
        parent.innerHTML = 'Parent invalid edit <div data-view-id="rogue" data-aotui-view="FixtureView">RAW_NESTED_VIEW</div>';
        sibling.textContent = 'Sibling invalid edit';

        let rejection: unknown;
        try {
            readViews(container);
        } catch (error) {
            rejection = error;
        }
        expect((rejection as Error).message).toContain('FixtureView');
        expect((rejection as Error).message).toContain('Parent');
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

it.each([
    ['row span', '<tr><td rowspan="2">Value</td><td>12</td></tr>', ', row 2, column 1: Merged cells are unsupported'],
    ['column span', '<tr><td>Value</td><td colSpan="2">12</td></tr>', ', row 2, column 2: Merged cells are unsupported'],
    ['short row', '<tr><td>Value</td></tr>', ', row 2, column 2: Expected 2 cells, got 1'],
    ['long row', '<tr><td>Value</td><td>12</td><td>other</td></tr>', ', row 2, column 3: Expected 2 cells, got 3'],
    ['nested table', '<tr><td><span><table><tr><th>nested</th></tr></table></span></td><td>12</td></tr>', ', row 2, column 1: Nested tables are unsupported'],
    ['text line break', '<tr><td>Value\r\nsecond line</td><td>12</td></tr>', ', row 2, column 1: Cell contains a line break'],
    ['JSX line break', '<tr><td>Value</td><td><span>12<br>13</span></td></tr>', ', row 2, column 2: Cell contains a line break'],
    ['block in cell', '<tr><td>Value</td><td><p>12</p></td></tr>', ', row 2, column 2: Cell needs text or inline markup'],
    ['header cell in data row', '<tr><th>Value</th><td>12</td></tr>', ', row 2, column 1: Expected a td cell'],
    ['unexpected row group', '<tfoot><tr><td>Value</td><td>12</td></tr></tfoot>', ': Expected tr, thead or tbody'],
])('reports the View, table and known cell location for %s', (_label, rest, diagnosis) => {
    const container = createContainer('<div data-aotui-view="Other" data-view-id="other">Other</div>' +
        '<div data-aotui-view="Inventory" data-view-id="stock">' +
        '<table><tr><th>First</th></tr></table><section><table><thead><tr><th>Item</th><th>Qty</th></tr></thead>' +
        rest + '</table></section></div>');
    expect(() => readViews(container)).toThrow(expect.objectContaining({
        name: 'SnapshotDataError', code: 'SNAPSHOT_INVALID', path: '$.views[1].content',
        message: `View "stock", table 2${diagnosis}. Use a simple table or list.`,
    }));
});
