import { applicationVisitor } from '../../visitors/application.visitor';
import { createTransformContext } from '../../types';
import { describe, expect, it, vi } from 'vitest';

import { createMockElement } from './test-utils';


describe('ApplicationVisitor', () => {
    it('matches element with data-app-id', () => {
        const el = createMockElement('<div data-app-id="app1"></div>');
        const ctx = createTransformContext();
        expect(applicationVisitor.matches(el, ctx)).toBe(true);
    });

    it('does not match element without data-app-id', () => {
        const el = createMockElement('<div></div>');
        const ctx = createTransformContext();
        expect(applicationVisitor.matches(el, ctx)).toBe(false);
    });

    it('wraps traversed content in an Application element', () => {
        const el = createMockElement('<div data-app-id="app1"><child></child></div>');
        const ctx = createTransformContext();
        const childrenTraverser = vi.fn().mockReturnValue(['child content']);

        const result = applicationVisitor.transform(el, ctx, childrenTraverser);

        expect(childrenTraverser).toHaveBeenCalledWith(el, ctx);
        expect(result).toBe('\n<application id="app1" name="">\nchild content\n</application>\n');
    });

    it('handles collapsed state', () => {
        const el = createMockElement('<div data-app-id="app1" data-state="collapsed"></div>');
        const ctx = createTransformContext();
        const childrenTraverser = vi.fn();

        const result = applicationVisitor.transform(el, ctx, childrenTraverser);

        expect(result).toContain('<application id="app1" name="" state="collapsed" />');
        expect(childrenTraverser).not.toHaveBeenCalled();
    });

    it('renders nested Applications without index bookkeeping', () => {
        const outer = createMockElement('<div data-app-id="outer" name="Outer"></div>');
        const inner = createMockElement('<div data-app-id="inner" name="Inner"></div>');
        const ctx = createTransformContext();
        const childrenTraverser = vi.fn().mockImplementation((element, context) => element === outer
            ? [applicationVisitor.transform(inner, context, childrenTraverser)]
            : ['inner content']);

        const result = applicationVisitor.transform(outer, ctx, childrenTraverser);

        expect(result).toContain('<application id="outer" name="Outer">');
        expect(result).toContain('<application id="inner" name="Inner">\ninner content\n</application>');
        expect(result).toContain('</application>');
        expect(childrenTraverser).toHaveBeenCalledTimes(2);
    });
});
