/**
 * DesktopManager Unit Tests
 * 
 * Tests the DesktopManager:
 * - Desktop creation and close ownership
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DesktopManager } from '../src/core/desktop-manager.js';

describe('DesktopManager', () => {
    let desktopManager: DesktopManager;

    beforeEach(async () => {
        desktopManager = new DesktopManager();
        await desktopManager.initialize({ appEntries: [] });
    });
    afterEach(async () => { await desktopManager.getKernel().beginClose().completion; });

    describe('createDesktop', () => {
        it('returns the assembled Desktop owner', async () => {
            const desktop = await desktopManager.createDesktop();
            expect(desktop.id).toMatch(/^dt_/);
            expect(desktopManager.getKernel().getDesktop(desktop.id)).toBe(desktop);
            expect(desktop.listApps()).toEqual([]);
        });

        it('should allow multiple Desktops to be created', async () => {
            const desktop1 = await desktopManager.createDesktop();
            const desktop2 = await desktopManager.createDesktop();

            expect(desktop1.id).not.toBe(desktop2.id);

            // Both should be retrievable
            expect(desktopManager.getDesktop(desktop1.id)).toBe(desktop1);
            expect(desktopManager.getDesktop(desktop2.id)).toBe(desktop2);
        });
    });

    it('allows the assembled Desktop owner to close and free its ID', async () => {
        const desktop = await desktopManager.createDesktop();
        expect(await desktop.beginClose().completion).toMatchObject({ scope: 'desktop', state: 'settled', resourcesReleased: true });
        expect(desktopManager.getDesktop(desktop.id)).toBeNull();
        const next = await desktopManager.createDesktop(desktop.id);
        expect(next).not.toBe(desktop);
    });
});
