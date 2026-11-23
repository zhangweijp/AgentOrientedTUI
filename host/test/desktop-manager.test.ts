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
    afterEach(async () => { await desktopManager.getKernel().shutdown(); });

    describe('createDesktop', () => {
        it('creates a Desktop with the reported number of installed Apps', async () => {
            const { desktop, thirdPartyAppCount } = await desktopManager.createDesktop();
            expect(desktop.id).toMatch(/^dt_/);
            expect(desktopManager.getKernel().getDesktop(desktop.id)).toBe(desktop);
            expect(thirdPartyAppCount).toBe(desktop.getInstalledApps().length);
        });

        it('should allow multiple Desktops to be created', async () => {
            const desktop1 = await desktopManager.createDesktop();
            const desktop2 = await desktopManager.createDesktop();

            expect(desktop1.desktop.id).not.toBe(desktop2.desktop.id);

            // Both should be retrievable
            expect(desktopManager.getDesktop(desktop1.desktop.id)).toBe(desktop1.desktop);
            expect(desktopManager.getDesktop(desktop2.desktop.id)).toBe(desktop2.desktop);
        });
    });

    it('allows the assembled Desktop owner to close and free its ID', async () => {
        const { desktop } = await desktopManager.createDesktop();
        expect(await desktop.beginClose().completion).toMatchObject({ intent: 'close', resourcesReleased: true });
        expect(desktopManager.getDesktop(desktop.id)).toBeNull();
        const next = await desktopManager.createDesktop(desktop.id);
        expect(next.desktop).not.toBe(desktop);
    });
});
