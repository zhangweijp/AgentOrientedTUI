import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { Config } from '../src/config/config.js';
import * as db from '../src/db/index.js';

vi.mock('../src/mcp/index.js', () => ({ MCP: { status: async () => ({}), clients: async () => ({}) } }));
vi.mock('../src/skills/skill-catalog-service.js', () => ({
    SkillCatalogService: class { async listSkills() { return []; } },
}));
afterEach(() => vi.restoreAllMocks());

describe('Host application identity across config and capability endpoints', () => {
    it('uses the active registry keys for both Agent settings and new Topic capabilities', async () => {
        vi.spyOn(Config, 'getGlobal').mockResolvedValue({});
        const ambient = vi.spyOn(Config, 'getAppsConfig').mockRejectedValue(new Error('Ambient registry must not be read'));
        const registry = { ide_key: { name: 'Friendly IDE', source: 'local:/apps/ide', enabled: true },
            terminal_key: { source: 'local:/apps/terminal', enabled: false } };
        const caller = appRouter.createCaller({ hostManager: { getAppsConfig: async () => registry } } as any);
        expect(Object.keys(await caller.apps.getConfig())).toEqual(['ide_key', 'terminal_key']);
        expect((await caller.sourceControl.getDraft()).apps.items).toEqual([
            { name: 'ide_key', enabled: true }, { name: 'terminal_key', enabled: false },
        ]);
        expect(ambient).not.toHaveBeenCalled();
    });

    it('shows persisted Topic overrides separately from installed apps', async () => {
        vi.spyOn(Config, 'getGlobal').mockResolvedValue({});
        vi.spyOn(db, 'getTopic').mockReturnValue({ id: 'topic' } as any);
        const caller = appRouter.createCaller({ hostManager: {
            getAppsConfig: async () => ({ ide_key: { enabled: true }, terminal_key: { enabled: true } }),
            getSourceControlState: () => ({ apps: { enabled: true, disabledItems: ['ide_key'] },
                mcp: { enabled: false, disabledItems: [] }, skill: { enabled: false, disabledItems: [] } }),
        } } as any);
        expect((await caller.sourceControl.getTopic({ id: 'topic' })).apps).toEqual({ enabled: true, items: [
            { name: 'ide_key', enabled: false }, { name: 'terminal_key', enabled: true },
        ] });
    });
});
