import { beforeAll, describe, expect, it } from 'vitest';

describe('planning app factory', () => {
    let PlanningAppFactory: any;

    beforeAll(async () => {
        PlanningAppFactory = (await import('../src/tui/index.js')).default;
    });

    it('exposes canonical app_name metadata', () => {
        expect(PlanningAppFactory.app_name).toBe('planning_app');
    });
});
