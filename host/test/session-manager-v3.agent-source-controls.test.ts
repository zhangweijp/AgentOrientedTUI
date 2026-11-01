import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManagerV3 } from '../src/core/session-manager-v3.js';
import * as db from '../src/db/index.js';

// Persisted Topic overrides remain authoritative, even after an Agent template is migrated.
describe('SessionManagerV3 persisted source controls', () => {
  let manager: SessionManagerV3 | null = null;
  afterEach(async () => {
    await manager?.cleanup();
    manager = null;
    vi.restoreAllMocks();
  });

  it('preserves explicit application disables and repairs only a selected item', () => {
    const controls = {
      apps: { enabled: true, disabledItems: ['system_ide', 'terminal'] },
      mcp: { enabled: false, disabledItems: ['server:playwright'] },
      skill: { enabled: false, disabledItems: ['existing-skill'] },
    };
    vi.spyOn(db, 'getTopic').mockReturnValue({ id: 'topic', sourceControls: controls } as any);
    const persist = vi.spyOn(db, 'updateTopic').mockImplementation(() => {});
    manager = new SessionManagerV3({} as any, {} as any, {} as any, {} as any);
    expect(manager.getSourceControlState('topic')).toEqual(controls);
    manager.setSourceItemEnabled('topic', 'apps', 'system_ide', true);
    const expected = { ...controls, apps: { enabled: true, disabledItems: ['terminal'] } };
    expect(manager.getSourceControlState('topic')).toEqual(expected);
    expect(persist).toHaveBeenCalledWith('topic', { sourceControls: expected, updatedAt: expect.any(Number) });
  });
});
