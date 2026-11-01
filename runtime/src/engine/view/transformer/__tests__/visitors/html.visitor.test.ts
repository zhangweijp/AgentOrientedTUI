import { htmlVisitor } from '../../visitors/html.visitor';
import { createTransformContext } from '../../types';
import { createMockElement } from './test-utils';
import { describe, expect, it, vi } from 'vitest';

describe('HtmlVisitor', () => {
    it('transforms headings and paragraphs', () => {
        const ctx = createTransformContext();
        expect(htmlVisitor.transform(createMockElement('<h1>Title</h1>'), ctx, vi.fn().mockReturnValue(['Title']))).toBe('\n# Title\n');
        expect(htmlVisitor.transform(createMockElement('<p>Para</p>'), ctx, vi.fn().mockReturnValue(['Para']))).toBe('\nPara\n');
    });

    it('transforms bold and italic text', () => {
        const ctx = createTransformContext();
        expect(htmlVisitor.transform(createMockElement('<b>Bold</b>'), ctx, vi.fn().mockReturnValue(['Bold']))).toBe('**Bold**');
        expect(htmlVisitor.transform(createMockElement('<i>Italic</i>'), ctx, vi.fn().mockReturnValue(['Italic']))).toBe('*Italic*');
    });

    it('transforms ordinary links', () => {
        const ctx = createTransformContext();
        const result = htmlVisitor.transform(createMockElement('<a href="https://example.com">Link</a>'), ctx, vi.fn().mockReturnValue(['Link']));
        expect(result).toBe('[Link](https://example.com)');
    });

    it('transforms code blocks', () => {
        const el = createMockElement('<pre><code class="language-ts">const a = 1;</code></pre>');
        const result = htmlVisitor.transform(el, createTransformContext(), vi.fn().mockReturnValue([]));
        expect(result).toContain('```ts');
        expect(result).toContain('const a = 1;');
        expect(result).toContain('```');
    });

    it('transforms blockquotes', () => {
        const result = htmlVisitor.transform(createMockElement('<blockquote>Quote\nLine 2</blockquote>'), createTransformContext(), vi.fn().mockReturnValue(['Quote\nLine 2']));
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
        const result = htmlVisitor.transform(el, createTransformContext(), children);
        expect(result).toContain('1. **Bold item**');
        expect(result).toContain('2. *Italic item*');
    });

    it('preserves nested list text', () => {
        const el = createMockElement('<ul><li>Item 1<ul><li>Nested item</li></ul></li></ul>');
        const result = htmlVisitor.transform(el, createTransformContext(), vi.fn().mockImplementation((childEl: Element) => [childEl.textContent || '']));
        expect(result).toContain('Item 1');
        expect(result).toContain('Nested item');
    });
});
