import { htmlVisitor } from '../../visitors/html.visitor';
import { createMockElement } from './test-utils';
import { transformElement } from '../../pure';
import { describe, expect, it, vi } from 'vitest';

describe('HtmlVisitor', () => {
    it('transforms headings and paragraphs', () => {
        expect(htmlVisitor.transform(createMockElement('<h1>Title</h1>'), vi.fn().mockReturnValue(['Title']))).toBe('\n# Title\n');
        expect(htmlVisitor.transform(createMockElement('<p>Para</p>'), vi.fn().mockReturnValue(['Para']))).toBe('\nPara\n');
    });

    it('transforms bold and italic text', () => {
        expect(htmlVisitor.transform(createMockElement('<b>Bold</b>'), vi.fn().mockReturnValue(['Bold']))).toBe('**Bold**');
        expect(htmlVisitor.transform(createMockElement('<i>Italic</i>'), vi.fn().mockReturnValue(['Italic']))).toBe('*Italic*');
    });

    it('transforms ordinary links', () => {
        const result = htmlVisitor.transform(createMockElement('<a href="https://example.com">Link</a>'), vi.fn().mockReturnValue(['Link']));
        expect(result).toBe('[Link](https://example.com)');
    });

    it('transforms code blocks', () => {
        const el = createMockElement('<pre><code class="language-ts">const a = 1;</code></pre>');
        const result = htmlVisitor.transform(el, vi.fn().mockReturnValue([]));
        expect(result).toContain('```ts');
        expect(result).toContain('const a = 1;');
        expect(result).toContain('```');
    });

    it('transforms blockquotes', () => {
        const result = htmlVisitor.transform(createMockElement('<blockquote>Quote\nLine 2</blockquote>'), vi.fn().mockReturnValue(['Quote\nLine 2']));
        expect(result).toContain('> Quote');
        expect(result).toContain('> Line 2');
    });

    it('preserves nested HTML formatting and content in lists', () => {
        const el = createMockElement('<ol><li><strong>Bold item</strong></li><li><em>Italic item</em></li></ol>');
        const children = vi.fn().mockImplementation((childEl: Element) => {
            if (childEl.tagName.toLowerCase() === 'strong') return ['**Bold item**'];
            if (childEl.tagName.toLowerCase() === 'em') return ['*Italic item*'];
            return [childEl.textContent || ''];
        });
        const result = htmlVisitor.transform(el, children);
        expect(result).toContain('1. **Bold item**');
        expect(result).toContain('2. *Italic item*');
    });

    it('preserves nested list text', () => {
        const el = createMockElement('<ul><li>Item 1<ul><li>Nested item</li></ul></li></ul>');
        const result = htmlVisitor.transform(el, vi.fn().mockImplementation((childEl: Element) => [childEl.textContent || '']));
        expect(result).toContain('Item 1');
        expect(result).toContain('Nested item');
    });

    it('passes ordinary data attributes through to their children', () => {
        const result = transformElement(createMockElement('<div data-app-id="app">Ordinary content <strong>bold</strong></div>'));
        expect(result.markup).toContain('Ordinary content');
        expect(result.markup).toContain('**bold**');
        expect(result.markup).not.toContain('<application');
    });
});
