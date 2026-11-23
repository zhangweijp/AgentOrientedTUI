import { transformElement } from '../../pure';
import { createMockElement } from './test-utils';
import { describe, expect, it } from 'vitest';

describe('View body projection', () => {
    it('recognizes the explicit semantic View root', () => {
        const el = createMockElement('<div data-aotui-view="Chat"><span>First</span><span>Second</span></div>');
        expect(transformElement(el)).toBe('First\nSecond');
    });

    it('does not infer a semantic View from a presentation attribute', () => {
        const el = createMockElement('<div view="Chat"><span>First</span><span>Second</span></div>');
        expect(transformElement(el)).toBe('FirstSecond');
    });

    it('keeps an element with view and href attributes as an ordinary link', () => {
        const el = createMockElement('<a view="chat-view" href="view:xyz">Label</a>');
        expect(transformElement(el)).toBe('[Label](view:xyz)');
    });

    it('does not infer a semantic View without view identifiers', () => {
        const el = createMockElement('<div><span>First</span><span>Second</span></div>');
        expect(transformElement(el)).toBe('FirstSecond');
    });

    it('projects only the View body and leaves metadata for the message boundary', () => {
        const el = createMockElement('<div data-aotui-view="Chat"><span>child content</span><span></span></div>');
        el.lastElementChild!.textContent = '<p>more content</p>';
        const result = transformElement(el);
        expect(result).toBe('child content\n<p>more content</p>');
        expect(result).not.toContain('<view');
    });

    it('does not add metadata when a View identity is missing', () => {
        const result = transformElement(createMockElement('<div view="chat">child</div>'));
        expect(result).toBe('child');
        expect(result).not.toContain('<view');
    });

    it('preserves adjacent raw text nodes and ignores comments', () => {
        const el = createMockElement('<div data-aotui-view="Raw"></div>');
        const doc = el.ownerDocument;
        const parts = ['  ', '  const x = 1;', '\r\n', '\r\n', ' \t'];
        el.append(doc.createTextNode(parts[0]!), doc.createComment('comment'), ...parts.slice(1).map(part => doc.createTextNode(part)));
        expect(transformElement(el)).toBe(parts.join(''));
    });

    it('preserves authored text between inline elements and separates independent JSX elements', () => {
        const el = createMockElement('<div data-aotui-view="Mixed">Hello <strong>world</strong>!\n<span>First</span> <span>Second</span></div>');
        expect(transformElement(el)).toBe('Hello **world**!\nFirst \nSecond');
    });
});
