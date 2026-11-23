import { createMockElement } from './test-utils';
import { transformElement } from '../../pure';
import { describe, expect, it } from 'vitest';

describe('HTML projection', () => {
    it('transforms headings and paragraphs', () => {
        expect(transformElement(createMockElement('<h1>Title</h1>'))).toBe('\n# Title\n');
        expect(transformElement(createMockElement('<p>Para</p>'))).toBe('\nPara\n');
    });

    it('transforms bold and italic text', () => {
        expect(transformElement(createMockElement('<b>Bold</b>'))).toBe('**Bold**');
        expect(transformElement(createMockElement('<i>Italic</i>'))).toBe('*Italic*');
    });

    it('keeps inline positions and block boundaries', () => {
        const el = createMockElement('<div><p>Hello <strong>world</strong>!<br>Next <a href="https://example.test">link</a>.</p>' +
            '<div>First <em>line</em>!</div><div>Second line.</div></div>');
        expect(transformElement(el)).toBe('\nHello **world**!\nNext [link](https://example.test).\nFirst *line*!\nSecond line.');
    });

    it('serializes direct and grouped rows in DOM order', () => {
        const el = createMockElement('<table><thead><tr><th>Item</th><th>Qty</th></tr></thead>' +
            '<tr><td>a|b</td><td></td></tr>\n<tbody><!-- comment --><tr><td>b</td><td>12</td></tr></tbody></table>');
        expect(transformElement(el)).toBe('\n\n| Item | Qty |\n| --- | --- |\n| a\\|b |  |\n| b | 12 |\n\n');
    });

    it('transforms ordinary links', () => {
        const result = transformElement(createMockElement('<a href="https://example.com">Link</a>'));
        expect(result).toBe('[Link](https://example.com)');
    });

    it('transforms code blocks', () => {
        const el = createMockElement('<pre><code class="language-ts">const a = 1;</code></pre>');
        const result = transformElement(el);
        expect(result).toContain('```ts');
        expect(result).toContain('const a = 1;');
        expect(result).toContain('```');
    });

    it('transforms blockquotes', () => {
        const result = transformElement(createMockElement('<blockquote>Quote\nLine 2</blockquote>'));
        expect(result).toContain('> Quote');
        expect(result).toContain('> Line 2');
    });

    it('preserves nested HTML formatting and content in lists', () => {
        const el = createMockElement('<ol><li><strong>Bold item</strong></li><li><em>Italic item</em></li></ol>');
        const result = transformElement(el);
        expect(result).toContain('1. **Bold item**');
        expect(result).toContain('2. *Italic item*');
    });

    it('preserves nested list text', () => {
        const el = createMockElement('<ul><li>Item 1<ul><li>Nested item</li></ul></li></ul>');
        const result = transformElement(el);
        expect(result).toContain('Item 1');
        expect(result).toContain('Nested item');
    });

    it('passes ordinary data attributes through to their children', () => {
        const result = transformElement(createMockElement('<div data-app-id="app">Ordinary content <strong>bold</strong></div>'));
        expect(result).toContain('Ordinary content');
        expect(result).toContain('**bold**');
        expect(result).not.toContain('<application');
    });
});
