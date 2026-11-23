import type { AppDiscoveryResult } from './app-catalog.js';

export function renderInstalledAppLines(apps: readonly AppDiscoveryResult[]): string[] {
    if (apps.length === 0) {
        return [
            'No apps installed.',
            '',
            'Install an app with: agentina install <source>',
        ];
    }

    const lines = ['Installed apps:', ''];

    for (const app of apps) {
        const { name } = app;
        if (app.status === 'failed') {
            const { code, path, message } = app.issue;
            lines.push(`  ⚠️ ${name} (invalid)`, `     ${code}${path ? ' ' + path : ''} ${message}`, '');
            continue;
        }
        const { entry } = app;
        const enabledStatus = entry.enabled ? '✅' : '❌';
        const autoStartStatus = (entry.autoStart ?? true) ? '🚀' : '⏸️';
        const status = app.status === 'disabled' ? ' (disabled)' : '';
        lines.push(`  ${enabledStatus}${autoStartStatus} ${name}${status}`);
        if (app.status === 'loaded') lines.push(`     Version: ${entry.distribution?.resolvedVersion ?? 'N/A'}`);

        if (entry.originalSource && entry.originalSource !== entry.source) {
            lines.push(`     Source: ${entry.originalSource}`);
            lines.push(`     Resolved: ${entry.source}`);
        } else {
            lines.push(`     Source: ${entry.source}`);
        }

        lines.push('');
    }

    lines.push('Legend: ✅=enabled ❌=disabled 🚀=auto-start ⏸️=manual-start');
    return lines;
}
