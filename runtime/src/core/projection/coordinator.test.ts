import { describe, expect, it } from 'vitest';
import { SemanticProjectionCoordinator } from './coordinator.js';

describe('M3 SemanticProjectionCoordinator (pure TypeScript)', () => {
    it('joins nested commits without depending on their coalesced notification', async () => {
        const c = new SemanticProjectionCoordinator(), owner = new AbortController();
        c.beginCommit(); c.beginCommit(); c.recordMutation('ref');
        let complete = false;
        const waiting = c.whenCommitted(owner.signal).then(() => { complete = true; });
        c.endCommit(); expect(complete).toBe(false);
        c.endCommit(); await waiting;
        expect(complete).toBe(true); expect((c as any).commits.size).toBe(0);
        const token = c.token(); await c.whenCommitted(owner.signal); expect(c.token()).toEqual(token);
    });

    it('releases an aborted commit wait and refuses already closed owners', async () => {
        const c = new SemanticProjectionCoordinator(), owner = new AbortController();
        c.beginCommit(); const waiting = c.whenCommitted(owner.signal); owner.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'PROJECTION_CLOSED' });
        expect((c as any).commits.size).toBe(0);
        await expect(c.whenCommitted(owner.signal)).rejects.toMatchObject({ code: 'PROJECTION_CLOSED' });
        c.endCommit();
    });
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
