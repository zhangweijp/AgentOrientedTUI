import { transformElement } from '../../pure';
import { createMockElement } from './test-utils';
import { describe, expect, it } from 'vitest';

describe('View body projection', () => {
    it('recognizes the explicit semantic View root', () => {
        const el = createMockElement('<div data-view-id="chat_view"><span>First</span><span>Second</span></div>');
        expect(transformElement(el).markup).toBe('First\nSecond');
    });

    it('does not infer a semantic View from a presentation attribute', () => {
        const el = createMockElement('<div view="Chat"><span>First</span><span>Second</span></div>');
        expect(transformElement(el).markup).toBe('First Second');
    });

    it('keeps an element with view and href attributes as an ordinary link', () => {
        const el = createMockElement('<a view="chat-view" href="view:xyz">Label</a>');
        expect(transformElement(el).markup).toBe('[Label](view:xyz)');
    });

    it('does not infer a semantic View without view identifiers', () => {
        const el = createMockElement('<div><span>First</span><span>Second</span></div>');
        expect(transformElement(el).markup).toBe('First Second');
    });

    it('projects only the View body and leaves metadata for the message boundary', () => {
        const el = createMockElement('<div data-view-id="v1" data-view-type="Chat" data-view-kind="state"><span>child content</span><span></span></div>');
        el.lastElementChild!.textContent = '<p>more content</p>';
        const result = transformElement(el).markup;
        expect(result).toBe('child content\n<p>more content</p>');
        expect(result).not.toContain('<view');
    });

    it('does not add metadata when a View identity is missing', () => {
        const result = transformElement(createMockElement('<div view="chat">child</div>')).markup;
        expect(result).toBe('child');
        expect(result).not.toContain('<view');
    });
});
