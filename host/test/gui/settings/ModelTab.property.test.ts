import { beforeAll, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { LLMConfigService } from '../../../src/core/llm-config-service.js';
import { initDatabase } from '../../../src/db/index.js';
import type { LLMConfigInput } from '../../../src/types/llm-config.js';
import type { ModelRegistry } from '../../../src/services/model-registry.js';

const service = new LLMConfigService({ getModels: async () => [] } as unknown as ModelRegistry);
const configuration = fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }),
    model: fc.uuid(),
    temperature: fc.double({ min: 0, max: 1, noNaN: true }),
});
const create = (input: Pick<LLMConfigInput, 'name' | 'model' | 'temperature'>) => service.createConfig({
    ...input, providerId: 'openai', baseUrl: 'https://fixture.invalid/v1', skipValidation: true,
});

describe('Model configuration deletion through the settings service', () => {
    beforeAll(() => initDatabase(':memory:'));

    it('deletes an active configuration and clears the active selection', async () => {
        await fc.assert(fc.asyncProperty(configuration, async input => {
            const config = await create(input);
            try {
                service.setActiveConfig(config.id);
                expect(service.getActiveLLMConfigRecord()?.id).toBe(config.id);
                service.deleteConfig(config.id);
                expect(service.getConfig(config.id)).toBeNull();
                expect(service.getActiveLLMConfigRecord()).toBeNull();
            } finally {
                service.deleteConfig(config.id);
            }
        }));
    });

    it('deletes an inactive configuration without changing the active selection', async () => {
        await fc.assert(fc.asyncProperty(configuration, configuration, async (activeInput, inactiveInput) => {
            const active = await create(activeInput);
            const inactive = await create(inactiveInput);
            try {
                service.setActiveConfig(active.id);
                expect(service.getConfig(inactive.id)?.isActive).toBe(false);
                service.deleteConfig(inactive.id);
                expect(service.getConfig(inactive.id)).toBeNull();
                expect(service.getActiveLLMConfigRecord()?.id).toBe(active.id);
            } finally {
                service.deleteConfig(inactive.id);
                service.deleteConfig(active.id);
            }
        }));
    });

    it('leaves another configuration intact after deleting the active one', async () => {
        await fc.assert(fc.asyncProperty(configuration, configuration, async (activeInput, otherInput) => {
            const active = await create(activeInput);
            const other = await create(otherInput);
            try {
                service.setActiveConfig(active.id);
                service.deleteConfig(active.id);
                expect(service.getActiveLLMConfigRecord()).toBeNull();
                expect(service.getConfig(other.id)).toMatchObject({ id: other.id, model: otherInput.model, isActive: false });
                service.setActiveConfig(other.id);
                expect(service.getActiveLLMConfigRecord()?.id).toBe(other.id);
            } finally {
                service.deleteConfig(active.id);
                service.deleteConfig(other.id);
            }
        }));
    });
});
