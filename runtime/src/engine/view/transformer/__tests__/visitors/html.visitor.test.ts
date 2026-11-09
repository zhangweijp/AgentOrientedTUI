import { createMockElement } from './test-utils';
import { transformElement } from '../../pure';
import { describe, expect, it } from 'vitest';

describe('HTML projection', () => {
    it('transforms headings and paragraphs', () => {
        expect(transformElement(createMockElement('<h1>Title</h1>')).markup).toBe('\n# Title\n');
        expect(transformElement(createMockElement('<p>Para</p>')).markup).toBe('\nPara\n');
    });

    it('transforms bold and italic text', () => {
        expect(transformElement(createMockElement('<b>Bold</b>')).markup).toBe('**Bold**');
        expect(transformElement(createMockElement('<i>Italic</i>')).markup).toBe('*Italic*');
    });

    it('transforms ordinary links', () => {
        const result = transformElement(createMockElement('<a href="https://example.com">Link</a>')).markup;
        expect(result).toBe('[Link](https://example.com)');
    });

    it('transforms code blocks', () => {
        const el = createMockElement('<pre><code class="language-ts">const a = 1;</code></pre>');
        const result = transformElement(el).markup;
        expect(result).toContain('```ts');
        expect(result).toContain('const a = 1;');
        expect(result).toContain('```');
    });

    it('transforms blockquotes', () => {
        const result = transformElement(createMockElement('<blockquote>Quote\nLine 2</blockquote>')).markup;
        expect(result).toContain('> Quote');
        expect(result).toContain('> Line 2');
    });

    it('preserves nested HTML formatting and content in lists', () => {
        const el = createMockElement('<ol><li><strong>Bold item</strong></li><li><em>Italic item</em></li></ol>');
        const result = transformElement(el).markup;
        expect(result).toContain('1. **Bold item**');
        expect(result).toContain('2. *Italic item*');
    });

    it('preserves nested list text', () => {
        const el = createMockElement('<ul><li>Item 1<ul><li>Nested item</li></ul></li></ul>');
        const result = transformElement(el).markup;
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
