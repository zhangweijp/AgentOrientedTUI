/**
 * DesktopManager Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DesktopManager } from './manager.js';
import { Desktop } from './desktop.js';

describe('DesktopManager', () => {
    let manager: DesktopManager;

    beforeEach(() => {
        manager = new DesktopManager();
    });

    // ─────────────────────────────────────────────────────────────
    //  Desktop 生命周期
    // ─────────────────────────────────────────────────────────────

    describe('create()', () => {
        it('should create desktop with auto-generated ID', async () => {
            const id = await manager.create();
            expect(id).toMatch(/^dt_/);
            expect(manager.get(id)).toBeDefined();
        });

        it('should create desktop with custom ID', async () => {
            const customId = 'custom_desktop_id';
            const id = await manager.create(customId);
            expect(id).toBe(customId);
            expect(manager.get(customId)).toBeDefined();
        });
    });

    describe('beginDesktopShutdown()', () => {
        it('should close and remove an existing desktop after confirmed release', async () => {
            const id = await manager.create();
            expect(manager.get(id)).toBeDefined();

            const handle = manager.beginDesktopShutdown(id);
            expect((await handle.completion).resourcesReleased).toBe(true);
            expect(manager.get(id)).toBeUndefined();
        });

        it('reports a missing desktop without inventing resources', async () => {
            await expect(manager.beginDesktopShutdown('non_existent').completion).resolves.toMatchObject({
                found: false, resourcesReleased: true, desktops: { accepted: 0, settled: 0 },
            });
        });
    });

    describe('get()', () => {
        it('should return desktop if exists', async () => {
            const id = await manager.create();
            const desktop = manager.get(id);
            expect(desktop).toBeDefined();
            expect(desktop?.id).toBe(id);
        });

        it('should return undefined if not exists', () => {
            expect(manager.get('non_existent')).toBeUndefined();
        });
    });

    // ─────────────────────────────────────────────────────────────
    //  生命周期控制
    // ─────────────────────────────────────────────────────────────

});
