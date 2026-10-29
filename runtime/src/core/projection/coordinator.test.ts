import { describe, expect, it } from 'vitest';
import { SemanticProjectionCoordinator } from './coordinator.js';

describe('M3 SemanticProjectionCoordinator (pure TypeScript)', () => {
    it('coalesces view, ref and tool changes inside explicit commit into one notification', async () => {
        const c = new SemanticProjectionCoordinator();
        const observed: Array<{ epoch: number; ready: boolean }> = [];
        const unsubscribe = c.subscribe(token => observed.push(token));
        c.beginCommit();
        expect(c.token()).toEqual({ epoch: 0, ready: false });
        c.recordMutation('view');
        c.recordMutation('ref');
        c.recordMutation('tool');
        expect(c.token()).toEqual({ epoch: 3, ready: false });
        await Promise.resolve();
        expect(observed).toHaveLength(0);
        c.endCommit();
        await Promise.resolve();
        expect(observed).toEqual([{ epoch: 3, ready: true }]);
        unsubscribe();
        c.recordMutation('ref');
        await Promise.resolve();
        expect(observed).toHaveLength(1);
    });

    it('supports nested commit scopes and refuses unbalanced closing', async () => {
        const c = new SemanticProjectionCoordinator();
        const seen: number[] = [];
        c.subscribe(token => seen.push(token.epoch));
        c.beginCommit();
        c.beginCommit();
        c.recordMutation('view');
        c.endCommit();
        await Promise.resolve();
        expect(seen).toEqual([]);
        c.endCommit();
        await Promise.resolve();
        expect(seen).toEqual([1]);
        expect(() => c.endCommit()).toThrow(/without begin/);
    });

    it('emits new epoch even when there is no DOM change, and isolates faulty listeners', async () => {
        const c = new SemanticProjectionCoordinator();
        const seen: number[] = [];
        c.subscribe(() => { throw new Error('Listener failure'); });
        c.subscribe(token => seen.push(token.epoch));
        c.recordMutation('ref');
        c.recordMutation('tool');
        await Promise.resolve();
        expect(seen).toEqual([2]);
        c.recordMutation('content');
        await Promise.resolve();
        expect(seen).toEqual([2, 3]);
    });

    it('does not announce updates during an unfinished commit even when notification already queued', async () => {
        const c = new SemanticProjectionCoordinator();
        const seen: number[] = [];
        c.subscribe(token => seen.push(token.epoch));
        c.recordMutation('content'); // queues microtask
        c.beginCommit();
        c.recordMutation('ref');
        await Promise.resolve();
        expect(seen).toEqual([]);
        expect(c.token().ready).toBe(false);
        c.endCommit();
        await Promise.resolve();
        expect(seen).toEqual([2]);
    });
});
