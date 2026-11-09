import { beforeAll, describe, expect, it } from 'vitest';

describe('planning app factory', () => {
    let PlanningAppFactory: any;

    beforeAll(async () => {
        PlanningAppFactory = (await import('../src/tui/index.js')).default;
    });

    it('exposes canonical app_name metadata', () => {
        const factory = PlanningAppFactory as { displayName?: string; kernelConfig?: { appName?: string } };
        expect(factory.displayName).toBe('planning_app');
        expect(factory.kernelConfig?.appName).toBe('planning_app');
    });
});
