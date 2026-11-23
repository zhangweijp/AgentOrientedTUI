import { expect, it } from 'vitest';
import { renderInstalledAppLines } from '../../src/app-distribution/cli-list.js';

it('lists the installation ID and distinguishes manual, disabled and invalid entries', () => {
    const entry = { source: 'local:/demo', enabled: true, autoStart: false };
    const lines = renderInstalledAppLines([
        { name: 'ide_install', entry, status: 'loaded' },
        { name: 'disabled_install', entry: { ...entry, enabled: false }, status: 'disabled' },
        { name: 'broken', status: 'failed', phase: 'discovery', issue: {
            code: 'APP_MANIFEST_INVALID', path: '/broken/aoapp.json', message: 'Missing entry point',
        } },
    ]).join('\n');

    expect(lines).toContain('✅⏸️ ide_install');
    expect(lines).toContain('❌⏸️ disabled_install (disabled)');
    expect(lines).toContain('broken (invalid)');
    expect(lines).toContain('APP_MANIFEST_INVALID /broken/aoapp.json Missing entry point');
});
