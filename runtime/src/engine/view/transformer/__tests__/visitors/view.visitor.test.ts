import { viewVisitor } from '../../visitors/view.visitor';
import { createMockElement } from './test-utils';
import { describe, expect, it, vi } from 'vitest';

describe('ViewVisitor', () => {
    it('matches element with view attribute (no href)', () => {
        const el = createMockElement('<div view="chat-view"></div>');
        expect(viewVisitor.matches(el)).toBe(true);
    });

    it('matches element with data-is-view attribute', () => {
        const el = createMockElement('<div data-is-view name="Chat"></div>');
        expect(viewVisitor.matches(el)).toBe(true);
    });

    it('does not match element with view attribute AND href (implies link)', () => {
        const el = createMockElement('<a view="chat-view" href="view:xyz"></a>');
        expect(viewVisitor.matches(el)).toBe(false);
    });

    it('does not match element without view identifiers', () => {
        const el = createMockElement('<div></div>');
        expect(viewVisitor.matches(el)).toBe(false);
    });

    it('wraps traversed content in the named View element', () => {
        const el = createMockElement('<div view="chat" id="v1"></div>');
        const childrenTraverser = vi.fn().mockReturnValue(['child content', '<p>more content</p>']);

        const result = viewVisitor.transform(el, childrenTraverser);

        expect(childrenTraverser).toHaveBeenCalledWith(el);
        expect(result).toBe('\n<view id="v1" name="chat">\nchild content\n<p>more content</p>\n</view>\n');
    });

    it('logs error and skips wrapper if id is missing', () => {
        const el = createMockElement('<div view="chat"></div>'); // No id
        const childrenTraverser = vi.fn().mockReturnValue(['child']);
        const spyError = vi.spyOn(console, 'error').mockImplementation(() => { });

        const result = viewVisitor.transform(el, childrenTraverser);

        expect(spyError).toHaveBeenCalled();
        expect(result).toBe('child'); // Not wrapped in <view>
        expect(result).not.toContain('<view');

        spyError.mockRestore();
    });
});
