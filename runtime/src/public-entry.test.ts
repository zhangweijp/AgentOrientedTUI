import { describe, expect, it } from 'vitest';
import * as runtime from './index.js';
import * as spi from './spi/index.js';

type PublicRootKeys = keyof typeof import('./index.js');
type PublicSPIKeys = keyof typeof import('./spi/index.js');
type AssertFalse<T extends false> = T;

// These compile-time checks keep implementation-only and retired contracts out
// of the package entry points.
type RootDoesNotExposeWorkerHost = AssertFalse<'AppWorkerHost' extends PublicRootKeys ? true : false>;
type RootDoesNotExposeLegacyDispatcher = AssertFalse<'IDispatcher' extends PublicRootKeys ? true : false>;
type SpiDoesNotExposeGenericWorkerRuntime = AssertFalse<'IWorkerRuntime' extends PublicSPIKeys ? true : false>;
type SpiDoesNotExposeWorkerIPC = AssertFalse<'MainToWorkerMessage' extends PublicSPIKeys ? true : false>;
type RootDoesNotExposeRetiredAppManifest = AssertFalse<'AOAppManifest' extends PublicRootKeys ? true : false>;
type SpiDoesNotExposeRetiredAppManifest = AssertFalse<'AOAppManifest' extends PublicSPIKeys ? true : false>;
type RootDoesNotExposeRetiredAppNameHelpers = AssertFalse<'isValidAppName' extends PublicRootKeys ? true : false>;
type SpiDoesNotExposeRetiredAppNameHelpers = AssertFalse<'validateManifest' extends PublicSPIKeys ? true : false>;
type RootDoesNotExposeRetiredAppEntry = AssertFalse<'AOAppEntry' extends PublicRootKeys ? true : false>;
type SpiDoesNotExposeRetiredAppEntry = AssertFalse<'AOAppEntry' extends PublicSPIKeys ? true : false>;
type RootDoesNotExposeRetiredAppRuntime = AssertFalse<'AOAppRuntime' extends PublicRootKeys ? true : false>;
type SpiDoesNotExposeRetiredAppRuntime = AssertFalse<'AOAppRuntime' extends PublicSPIKeys ? true : false>;
type RootDoesNotExposeRetiredAppView = AssertFalse<'AOAppView' extends PublicRootKeys ? true : false>;
type SpiDoesNotExposeRetiredAppView = AssertFalse<'AOAppView' extends PublicSPIKeys ? true : false>;
type SpiDoesNotExposeUnusedIdGuards = AssertFalse<'isDesktopId' extends PublicSPIKeys ? true : false>;
type SpiDoesNotExposeAppIdGuard = AssertFalse<'isAppId' extends PublicSPIKeys ? true : false>;
type SpiDoesNotExposeViewIdGuard = AssertFalse<'isViewId' extends PublicSPIKeys ? true : false>;
type AOTUIErrorInstanceKeys = keyof InstanceType<typeof spi.AOTUIError>;
type AOTUIErrorStaticKeys = keyof typeof spi.AOTUIError;
type AOTUIErrorDoesNotExposeTypeGuard = AssertFalse<'is' extends AOTUIErrorStaticKeys ? true : false>;
type AOTUIErrorDoesNotExposeFromError = AssertFalse<'fromError' extends AOTUIErrorStaticKeys ? true : false>;

describe('Runtime public entry points', () => {
    it('exposes the host factory and supported host registration surface', () => {
        expect(runtime.createRuntime).toBeTypeOf('function');
        expect(runtime.AppRegistry).toBeTypeOf('function');
        expect(runtime.SEMANTIC_INTERACTION_MODES).toEqual(['view-type-parameters-v1']);
        expect(runtime).not.toHaveProperty('AOAppManifest');
        expect(runtime).not.toHaveProperty('validateManifest');
        expect(runtime).not.toHaveProperty('isValidAppName');
        expect(runtime).not.toHaveProperty('AOAppEntry');
        expect(runtime).not.toHaveProperty('AOAppRuntime');
        expect(runtime).not.toHaveProperty('AOAppView');
        expect(runtime).not.toHaveProperty('failedResult');
        expect(runtime).not.toHaveProperty('isDesktopId');
    });

    it('exposes SDK ports without exposing Worker IPC', () => {
        expect(spi.AOTUIError).toBeTypeOf('function');
        expect(spi.isTUIAppFactory).toBeTypeOf('function');
        expect(spi).not.toHaveProperty('AOAppManifest');
        expect(spi).not.toHaveProperty('validateManifest');
        expect(spi).not.toHaveProperty('AOAppEntry');
        expect(spi).not.toHaveProperty('failedResult');
        expect(spi).not.toHaveProperty('isViewId');
        expect(spi).not.toHaveProperty('generateRequestId');
    });
});
