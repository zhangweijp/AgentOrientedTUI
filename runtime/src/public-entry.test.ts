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

describe('Runtime public entry points', () => {
    it('exposes the host factory and supported host registration surface', () => {
        expect(runtime.createRuntime).toBeTypeOf('function');
        expect(runtime.AppRegistry).toBeTypeOf('function');
        expect(runtime.SEMANTIC_INTERACTION_MODES).toEqual(['ordinary-v2', 'snapshot-value-v2']);
    });

    it('exposes SDK ports without exposing Worker IPC', () => {
        expect(spi.AOTUIError).toBeTypeOf('function');
        expect(spi.isTUIAppFactory).toBeTypeOf('function');
        expect(spi).not.toHaveProperty('generateRequestId');
    });
});
