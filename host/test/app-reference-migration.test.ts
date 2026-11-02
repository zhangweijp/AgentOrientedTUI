import { describe, expect, it } from 'vitest';
import { migrateAgentAppReferences } from '../src/config/app-reference-migration.js';
import type { Info } from '../src/config/config.js';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const registry = {
    system_ide: { source: 'local:/apps/aotui-ide', enabled: true },
    terminal: { source: 'local:/apps/terminal-app', enabled: true },
    lite_browser: { source: 'local:/apps/lite-browser-app', enabled: true },
};
const renames = { 'aotui-ide': 'system_ide', 'terminal-app': 'terminal', 'lite-browser-app': 'lite_browser' };
const config: Info = { agents: { activeAgentId: 'agent', list: [{
    id: 'agent', name: 'Agent', prompt: 'Keep this', modelId: 'provider/model',
    enabledApps: ['aotui-ide', 'planning-app', 'terminal-app', 'token-monitor-app', 'lite-browser-app'],
    enabledMCPs: ['existing-mcp'], enabledSkills: { global: ['existing-skill'] }, skin: {},
}] }, experimental: { preserved: true } };

describe('explicit Agent application reference migration', () => {
    it('runs as a dry-run by default, backs up the original on write, and is idempotent', () => {
        const directory = mkdtempSync(join(tmpdir(), 'aotui-app-migration-'));
        try {
            const configPath = join(directory, 'mcp.json');
            const original = JSON.stringify(config);
            writeFileSync(configPath, original);
            writeFileSync(join(directory, 'registry.json'), JSON.stringify({ apps: registry }));
            writeFileSync(join(directory, 'renames.json'), JSON.stringify(renames));
            const args = ['--import', 'tsx', fileURLToPath(new URL('../scripts/migrate-agent-app-references.ts', import.meta.url)),
                '--config', configPath, '--registry', join(directory, 'registry.json'), '--renames', join(directory, 'renames.json')];
            execFileSync(process.execPath, args);
            expect(readFileSync(configPath, 'utf8')).toBe(original);
            expect(readdirSync(directory)).toHaveLength(3);
            execFileSync(process.execPath, [...args, '--write']);
            const backup = readdirSync(directory).find(name => name.includes('.before-app-reference-migration-'))!;
            expect(readFileSync(join(directory, backup), 'utf8')).toBe(original);
            expect(JSON.parse(readFileSync(configPath, 'utf8')).agents.list[0].enabledApps).toContain('system_ide');
            execFileSync(process.execPath, [...args, '--write']);
            expect(readdirSync(directory)).toHaveLength(4);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    it('renames only the approved references, preserving missing apps and unrelated config', () => {
        const before = structuredClone(config);
        const result = migrateAgentAppReferences(config, registry, renames);
        expect(result.config.agents!.list[0].enabledApps).toEqual(['system_ide', 'planning-app', 'terminal', 'token-monitor-app', 'lite_browser']);
        expect(result.changes).toHaveLength(3);
        expect(result.config).toEqual({ ...config, agents: { ...config.agents!, list: [{ ...config.agents!.list[0], enabledApps: result.config.agents!.list[0].enabledApps }] } });
        expect(config).toEqual(before);
        const again = migrateAgentAppReferences(result.config, registry, renames);
        expect(again.changes).toEqual([]);
        expect(again.config).toBe(result.config);
    });

    it('does not add unselected apps and merges an already selected replacement only once', () => {
        const input = structuredClone(config);
        input.agents!.list[0].enabledApps = ['aotui-ide', 'system_ide'];
        expect(migrateAgentAppReferences(input, registry, renames).config.agents!.list[0].enabledApps).toEqual(['system_ide']);
    });

    it('refuses missing targets and names belonging to another registered app', () => {
        expect(() => migrateAgentAppReferences(config, {}, renames)).toThrow('not registered');
        expect(() => migrateAgentAppReferences(config, { ...registry, 'aotui-ide': registry.terminal }, renames)).toThrow('still registered');
    });
});
