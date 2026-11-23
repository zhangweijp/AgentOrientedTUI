import { describe, expect, it } from 'vitest';
import * as runtime from './index.js';
import { AOTUIError } from '@aotui/core';

type PublicRootKeys = keyof typeof import('./index.js');
type AssertFalse<T extends false> = T;

// These compile-time checks keep implementation-only and retired contracts out
// of the package entry points.
type RootDoesNotExposeWorkerHost = AssertFalse<'AppWorkerHost' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeLegacyDispatcher = AssertFalse<'IDispatcher' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeWorkerIPC = AssertFalse<'MainToWorkerMessage' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeRetiredAppManifest = AssertFalse<'AOAppManifest' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeRetiredAppNameHelpers = AssertFalse<'isValidAppName' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeRetiredAppEntry = AssertFalse<'AOAppEntry' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeRetiredAppRuntime = AssertFalse<'AOAppRuntime' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeRetiredAppView = AssertFalse<'AOAppView' extends PublicRootKeys ? true : false>;
type AOTUIErrorStaticKeys = keyof typeof runtime.AOTUIError;
type AOTUIErrorDoesNotExposeTypeGuard = AssertFalse<'is' extends AOTUIErrorStaticKeys ? true : false>;
type AOTUIErrorDoesNotExposeFromError = AssertFalse<'fromError' extends AOTUIErrorStaticKeys ? true : false>;

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
