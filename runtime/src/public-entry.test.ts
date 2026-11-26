import { describe, expect, it } from 'vitest';
import * as runtime from './index.js';
import { AOTUIError } from '@aotui/core';

describe('Runtime public entry points', () => {
    it('exposes the host factory and supported host registration surface', () => {
        expect(runtime.createRuntime).toBeTypeOf('function');
        expect(runtime.readAppManifest).toBeTypeOf('function');
        expect(runtime).not.toHaveProperty('AppRegistry');
        expect(runtime).not.toHaveProperty('SEMANTIC_INTERACTION_MODES');
        expect(runtime).not.toHaveProperty('AOAppManifest');
        expect(runtime).not.toHaveProperty('validateManifest');
        expect(runtime).not.toHaveProperty('isValidAppName');
        expect(runtime).not.toHaveProperty('AOAppEntry');
        expect(runtime).not.toHaveProperty('AOAppRuntime');
        expect(runtime).not.toHaveProperty('AOAppView');
        expect(runtime).not.toHaveProperty('failedResult');
        expect(runtime).not.toHaveProperty('isDesktopId');
    });

    it('uses the Core error', () => {
        expect(runtime.AOTUIError).toBe(AOTUIError);
    });
});
