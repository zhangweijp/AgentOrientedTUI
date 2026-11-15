import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@aotui/sdk', async () => import('../../../sdk/src/index.ts'));

describe('token monitor app factory', () => {
    let TokenMonitorAppFactory: any;

    beforeAll(async () => {
        TokenMonitorAppFactory = (await import('../src/tui/index.js')).default;
    });

    it('exposes canonical app_name metadata', () => {
        expect(TokenMonitorAppFactory.kernelConfig.appName).toBe('token_monitor');
    });
});
