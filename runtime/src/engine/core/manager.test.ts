/**
 * DesktopManager Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DesktopManager } from './manager.js';

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
            expect(manager.has(id)).toBe(true);
        });

        it('should create desktop with custom ID', async () => {
            const customId = 'custom_desktop_id';
            const id = await manager.create(customId);
            expect(id).toBe(customId);
            expect(manager.has(customId)).toBe(true);
        });
    });

    describe('beginDesktopShutdown()', () => {
        it('should close and remove an existing desktop after confirmed release', async () => {
            const id = await manager.create();
            expect(manager.has(id)).toBe(true);

            const operation = manager.beginDesktopShutdown(id);
            expect((await operation.completion).resourcesReleased).toBe(true);
            expect(manager.has(id)).toBe(false);
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
    //  App 管理 - [Worker-Only Migration]
    // ─────────────────────────────────────────────────────────────

    // installApp() and getApp() tests removed.
    // In Worker-Only architecture, use installDynamicWorkerApp instead.

    // ─────────────────────────────────────────────────────────────
    //  Desktop 状态
    // ─────────────────────────────────────────────────────────────



    describe('getDesktopInfo()', () => {
        it('should return info for existing desktop', async () => {
            const id = await manager.create();
            const info = manager.getDesktopInfo(id);

            expect(info).toBeDefined();
            expect(info?.status).toBe('active');
            expect(info?.createdAt).toBeLessThanOrEqual(Date.now());
        });

        it('should return undefined for non-existent desktop', () => {
            expect(manager.getDesktopInfo('non_existent')).toBeUndefined();
        });
    });

    // ─────────────────────────────────────────────────────────────
    //  生命周期控制
    // ─────────────────────────────────────────────────────────────

    describe('suspend() and resume()', () => {
        it('should suspend desktop', async () => {
            const id = await manager.create();
            await manager.suspend(id);

            const info = manager.getDesktopInfo(id);
            expect(info?.status).toBe('suspended');
        });

        it('should resume suspended desktop', async () => {
            const id = await manager.create();
            await manager.suspend(id);
            await manager.resume(id);

            const info = manager.getDesktopInfo(id);
            expect(info?.status).toBe('active');
        });

        it('should throw E_NOT_FOUND for non-existent desktop', async () => {
            await expect(manager.suspend('non_existent')).rejects.toThrow(/DESKTOP_NOT_FOUND|not found/);
            await expect(manager.resume('non_existent')).rejects.toThrow(/DESKTOP_NOT_FOUND|not found/);
        });
    });
});

