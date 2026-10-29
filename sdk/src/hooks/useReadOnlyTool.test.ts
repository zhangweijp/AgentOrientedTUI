import { describe, expect, it } from 'vitest';
import { experimental_useReadOnlyTool as publicHook } from '../index.js';
import { experimental_useReadOnlyTool } from './useReadOnlyTool.js';
describe('R02 explicit experimental SDK root export', () => {
  it('exports the new hook without replacing the legacy API', () => {
    expect(publicHook).toBe(experimental_useReadOnlyTool);
    expect(typeof publicHook).toBe('function');
  });
});
