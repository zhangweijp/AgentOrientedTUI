import { describe, expect, it } from 'vitest';
import TokenMonitorAppFactory from '../src/tui/index.js';

describe('token monitor app factory', () => {
    it('exposes canonical app_name metadata', () => {
        expect(TokenMonitorAppFactory.kernelConfig.appName).toBe('token_monitor');
    });
});
