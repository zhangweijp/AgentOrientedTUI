import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillDrivenSource } from '../src/skills/skill-driven-source.js';
import type { SkillInfo } from '../src/skills/types.js';

const catalog = vi.hoisted(() => ({
  listSkills: vi.fn<() => Promise<SkillInfo[]>>(),
  getSkill: vi.fn<(name: string) => Promise<SkillInfo | undefined>>(),
}));
vi.mock('../src/skills/skill-catalog-service.js', () => ({
  SkillCatalogService: class {
    listSkills = catalog.listSkills;
    getSkill = catalog.getSkill;
  },
}));
const alpha: SkillInfo = { name: 'alpha', description: 'Alpha skill', content: 'Alpha body', location: '/controlled/alpha/SKILL.md', scope: 'project' };
beforeEach(() => {
  catalog.listSkills.mockReset().mockResolvedValue([alpha]);
  catalog.getSkill.mockReset().mockImplementation(async name => name === alpha.name ? alpha : undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('SkillDrivenSource atomic context', () => {
  it('captures its catalog, schema and load route without a model executor', async () => {
    const source = new SkillDrivenSource(), update = vi.fn();
    const off = source.onUpdate(update);
    try {
      const context = await source.getContext();
      expect(context.messages).toEqual([]);
      expect(context.tools.skill.description).toContain('- alpha: Alpha skill');
      expect(context.tools.skill.execute).toBeUndefined();
      expect(catalog.listSkills).toHaveBeenCalledTimes(1);
      expect(await context.executeTool!('skill', { name: ' alpha ' }, 'load')).toEqual({
        toolName: 'skill', toolCallId: 'load', result: '<skill_content name="alpha">\n# Skill: alpha\n\nAlpha body\n\nLocation: /controlled/alpha/SKILL.md\nScope: project\n</skill_content>',
      });
      expect(catalog.getSkill).toHaveBeenCalledExactlyOnceWith('alpha');
      expect(update).toHaveBeenCalledTimes(1);
      off(); source.setEnabled(false); expect(update).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });

  it('keeps Source enable and per-skill controls, including a disable after capture', async () => {
    const source = new SkillDrivenSource(), update = vi.fn();
    source.onUpdate(update);
    source.setEnabled(false);
    await expect(source.getContext()).resolves.toEqual({ messages: [], tools: {} });
    expect(catalog.listSkills).not.toHaveBeenCalled();
    source.setEnabled(true);
    const context = await source.getContext();
    source.setSkillEnabled('alpha', false); update.mockClear();
    expect(await context.executeTool!('skill', { name: 'alpha' }, 'disabled')).toEqual({
      toolName: 'skill', toolCallId: 'disabled', error: { code: 'E_SKILL_DISABLED', message: 'Skill "alpha" is temporarily disabled for this topic.' },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect((await source.getContext()).tools.skill.description).toBe('Load a specialized skill. No skills are currently available.');
    expect(source.getControlState()).toEqual({ enabled: true, disabledSkills: ['alpha'] });
    source.setSkillEnabled('alpha', true);
    expect((await source.getContext()).tools.skill.description).toContain('alpha');
  });

  it('preserves missing input, unknown name, unknown tool and notification results', async () => {
    const source = new SkillDrivenSource(), update = vi.fn(), context = await source.getContext();
    source.onUpdate(update);
    expect(await context.executeTool!('other', {}, 'other')).toBeUndefined();
    expect(await context.executeTool!('skill', {}, 'missing')).toEqual({
      toolName: 'skill', toolCallId: 'missing', error: { code: 'E_INVALID_ARGS', message: 'Missing required field: name' },
    });
    expect(catalog.getSkill).not.toHaveBeenCalled();
    expect(await context.executeTool!('skill', { name: 'absent' }, 'unknown')).toEqual({
      toolName: 'skill', toolCallId: 'unknown', error: { code: 'E_SKILL_NOT_FOUND', message: 'Skill "absent" not found. Available skills: alpha' },
    });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('diagnoses capture failure, returns a full empty context, and retries next capture', async () => {
    const failure = new Error('catalog unavailable'), source = new SkillDrivenSource();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    catalog.listSkills.mockRejectedValueOnce(failure);
    await expect(source.getContext()).resolves.toEqual({ messages: [], tools: {} });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('[SkillDrivenSource] Failed to capture skill context', failure);
    expect((await source.getContext()).tools).toHaveProperty('skill');
    expect(catalog.listSkills).toHaveBeenCalledTimes(2);
  });

  it('keeps execution read errors and does not retry or issue a completion update', async () => {
    const failure = new Error('body read failed'), source = new SkillDrivenSource(), update = vi.fn();
    const context = await source.getContext();
    source.onUpdate(update); catalog.getSkill.mockRejectedValueOnce(failure);
    await expect(context.executeTool!('skill', { name: 'alpha' }, 'failed')).rejects.toBe(failure);
    expect(catalog.getSkill).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('uses the captured catalog instance rather than a later source catalog', async () => {
    const source = new SkillDrivenSource(), first = await source.getContext();
    const beta: SkillInfo = { ...alpha, name: 'beta', content: 'Beta body' };
    const later = { listSkills: vi.fn(async () => [beta]), getSkill: vi.fn(async () => beta) };
    Reflect.set(source, 'catalog', later);
    const second = await source.getContext();
    expect((await first.executeTool!('skill', { name: 'alpha' }, 'first'))?.result).toContain('Alpha body');
    expect((await second.executeTool!('skill', { name: 'beta' }, 'second'))?.result).toContain('Beta body');
    expect(catalog.getSkill).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(later.getSkill).toHaveBeenCalledExactlyOnceWith('beta');
    expect(first.tools.skill.description).toContain('alpha');
    expect(second.tools.skill.description).toContain('beta');
  });
});
