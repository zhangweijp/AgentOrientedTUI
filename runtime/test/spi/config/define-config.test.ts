
import { describe, it, expect } from 'vitest';
import { defineRuntimeConfig, RUNTIME_DEFAULTS } from '../../../src/spi/config/define-config.js';
import { AOTUIError } from '../../../src/spi/core/errors.js';
import * as configExports from '../../../src/spi/config/index.js';

function captureError(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    return undefined;
}

function expectConfigError(error: unknown, path: string): AOTUIError {
    expect(error).toBeInstanceOf(AOTUIError);
    const configError = error as AOTUIError;
    expect(configError.code).toBe('CONFIG_INVALID');
    expect(configError.message).toContain(`[${path}]`);
    expect(configError.context.reason).toContain(`[${path}]`);
    expect(configError.context).not.toHaveProperty('errors');
    return configError;
}

describe('Configuration Architecture', () => {

    describe('defineRuntimeConfig (Builder)', () => {
        it('exports only config domains that have Runtime consumers', () => {
            expect(RUNTIME_DEFAULTS).not.toHaveProperty('bridge');
            expect(RUNTIME_DEFAULTS).not.toHaveProperty('transform');
            expect(configExports).not.toHaveProperty('BRIDGE_DEFAULTS');
            expect(configExports).not.toHaveProperty('BridgeConfig');
            expect(configExports).not.toHaveProperty('TRANSFORM_DEFAULTS');
            expect(configExports).not.toHaveProperty('TransformConfig');
            expect(configExports).not.toHaveProperty('validateRuntimeConfig');
        });

        it('should return complete default config when input is empty', () => {
            const config = defineRuntimeConfig();

            expect(config.worker.timeoutMs).toBe(30_000);
            expect(config).not.toHaveProperty('bridge');
            expect(config).not.toHaveProperty('transform');
            expect(config).not.toHaveProperty('lock');
            expect(config).not.toHaveProperty('snapshot');

            // Check deep properties
            expect(config.worker.pool.initialSize).toBe(2);
            expect(config.worker.pool.maxSize).toBe(10);
        });

        it('should return a frozen immutable object', () => {
            const config = defineRuntimeConfig();
            expect(Object.isFrozen(config)).toBe(true);
            expect(Object.isFrozen(config.worker)).toBe(true);
            expect(Object.isFrozen(config.worker.pool)).toBe(true);
            expect(Object.isFrozen(config.logger)).toBe(true);
        });

        it('keeps defaults immutable and overridden instances detached from inputs', () => {
            const first = defineRuntimeConfig();
            const input = { worker: { pool: { maxSize: 12 } }, logger: { maxSystemLogs: 80 } };
            const overridden = defineRuntimeConfig(input);
            const later = defineRuntimeConfig();

            expect(overridden.worker).not.toBe(input.worker);
            expect(overridden.worker.pool).not.toBe(input.worker.pool);
            expect(overridden.logger).not.toBe(input.logger);
            expect(first.worker.pool.maxSize).toBe(10);
            expect(later.worker.pool.maxSize).toBe(10);
            expect(overridden.worker.pool.maxSize).toBe(12);
            expect(first.worker.pool).toBe(later.worker.pool);
            expect(Object.isFrozen(first.worker.pool)).toBe(true);
            expect(Object.isFrozen(overridden.worker.pool)).toBe(true);
            expect(Object.isFrozen(RUNTIME_DEFAULTS.worker)).toBe(true);
            expect(Object.isFrozen(RUNTIME_DEFAULTS.worker.pool)).toBe(true);
            expect(Object.isFrozen(RUNTIME_DEFAULTS.logger)).toBe(true);

            input.worker.pool.maxSize = 20;
            input.logger.maxSystemLogs = 90;
            expect(overridden.worker.pool.maxSize).toBe(12);
            expect(overridden.logger.maxSystemLogs).toBe(80);
            expect(Object.isFrozen(input)).toBe(false);
            expect(Object.isFrozen(input.worker.pool)).toBe(false);
            expect(Object.isFrozen(input.logger)).toBe(false);
        });

        it('should merge top-level overrides correctly', () => {
            const config = defineRuntimeConfig({
                worker: { timeoutMs: 60_000 },
                logger: { maxSystemLogs: 20 },
            });

            expect(config.worker.timeoutMs).toBe(60_000);
            expect(config.logger.maxSystemLogs).toBe(20);
            expect(config.worker.pool.initialSize).toBe(2);
        });

        it('should merge nested overrides deeply', () => {
            const config = defineRuntimeConfig({
                worker: {
                    pool: { maxSize: 20 }
                }
            });

            expect(config.worker.pool.maxSize).toBe(20);
            expect(config.worker.pool.initialSize).toBe(2); // Should persist from existing nested object
            expect(config.worker.timeoutMs).toBe(30_000);  // Sibling prop in parent
        });

        it('rejects root, nested, and leaf accessors without evaluating getters', () => {
            const cases: Array<[string, (onRead: () => void) => unknown]> = [
                ['worker', onRead => {
                    const input = {};
                    Object.defineProperty(input, 'worker', { enumerable: true, get() { onRead(); return {}; } });
                    return input;
                }],
                ['worker.pool', onRead => ({ worker: Object.defineProperty({}, 'pool', {
                    enumerable: true, get() { onRead(); return {}; },
                }) })],
                ['worker.pool.maxSize', onRead => ({ worker: { pool: Object.defineProperty({}, 'maxSize', {
                    enumerable: true, get() { onRead(); return 12; },
                }) } })],
            ];

            for (const [path, createInput] of cases) {
                let getterCalls = 0;
                const error = captureError(() => defineRuntimeConfig(createInput(() => { getterCalls++; }) as any));
                const configError = expectConfigError(error, path);
                expect(configError.message).toContain('accessor');
                expect(getterCalls).toBe(0);
            }
        });

        it('rejects non-enumerable configuration fields without evaluating accessors', () => {
            let getterCalls = 0;
            const accessorInput = {};
            Object.defineProperty(accessorInput, 'worker', {
                get() { getterCalls++; return {}; },
            });
            const accessorError = expectConfigError(captureError(() => defineRuntimeConfig(accessorInput as any)), 'worker');
            expect(accessorError.message).toContain('accessor');
            expect(getterCalls).toBe(0);

            const dataInput = {};
            Object.defineProperty(dataInput, 'worker', { value: {}, enumerable: false });
            const dataError = expectConfigError(captureError(() => defineRuntimeConfig(dataInput as any)), 'worker');
            expect(dataError.message).toContain('enumerable');
        });

        it('rejects symbol configuration keys with their key path', () => {
            const input = { worker: { timeoutMs: 60_000 } } as any;
            input.worker[Symbol('hidden')] = 1;

            expectConfigError(captureError(() => defineRuntimeConfig(input)), 'worker.Symbol(hidden)');
        });

        it('accepts ordinary and null-prototype partial data without mutating inputs', () => {
            const ordinary = { worker: { pool: { maxSize: 12 } }, logger: { maxSystemLogs: 80 } };
            const nullPool = Object.assign(Object.create(null), { maxSize: 13 });
            const nullWorker = Object.assign(Object.create(null), { pool: nullPool });
            const nullLogger = Object.assign(Object.create(null), { maxSystemLogs: 140 });
            const nullInput = Object.assign(Object.create(null), { worker: nullWorker, logger: nullLogger });

            for (const [input, maxSize, maxSystemLogs] of [
                [ordinary, 12, 80],
                [nullInput, 13, 140],
            ] as const) {
                const config = defineRuntimeConfig(input as any);
                expect(config.worker.pool.maxSize).toBe(maxSize);
                expect(config.worker.pool.initialSize).toBe(2);
                expect(config.logger.maxSystemLogs).toBe(maxSystemLogs);
                expect(Object.isFrozen(input)).toBe(false);
            }

            expect(ordinary).toEqual({ worker: { pool: { maxSize: 12 } }, logger: { maxSystemLogs: 80 } });
            expect(Object.getPrototypeOf(nullInput)).toBeNull();
            expect(Object.getPrototypeOf(nullWorker)).toBeNull();
            expect(Object.getPrototypeOf(nullPool)).toBeNull();
            expect(Object.getPrototypeOf(nullLogger)).toBeNull();
            expect(Reflect.ownKeys(nullInput)).toEqual(['worker', 'logger']);
            expect(Reflect.ownKeys(nullPool)).toEqual(['maxSize']);
            expect(nullPool.maxSize).toBe(13);
        });

        it('uses defaults for explicitly undefined partial fields', () => {
            expect(defineRuntimeConfig({ worker: undefined, logger: { maxSystemLogs: undefined } })).toMatchObject({
                worker: { timeoutMs: 30_000, pool: { maxSize: 10 } },
                logger: { maxSystemLogs: 100 },
            });
        });

        it('rejects non-plain root and nested object shapes with their paths', () => {
            class ConfigInput { worker = { timeoutMs: 60_000 }; }
            class WorkerInput { timeoutMs = 60_000; }
            const cases: Array<[unknown, string]> = [
                [null, 'configuration'],
                [[], 'configuration'],
                [new ConfigInput(), 'configuration'],
                [{ worker: null }, 'worker'],
                [{ worker: [] }, 'worker'],
                [{ worker: new WorkerInput() }, 'worker'],
                [{ worker: { pool: null } }, 'worker.pool'],
                [{ worker: { pool: [] } }, 'worker.pool'],
            ];

            for (const [input, path] of cases) {
                expectConfigError(captureError(() => defineRuntimeConfig(input as any)), path);
            }
        });
    });

    describe('Validation Logic', () => {
        it('should pass with valid custom configuration', () => {
            expect(() => defineRuntimeConfig({
                worker: { timeoutMs: 50_000 }
            })).not.toThrow();
        });

        it('should throw CONFIG_INVALID when worker timeout is too small', () => {
            try {
                defineRuntimeConfig({
                    worker: { timeoutMs: 100 } // Below 1000
                });
                throw new Error('Should have thrown');
            } catch (error: any) {
                expect(error).toBeInstanceOf(AOTUIError);
                expect(error.code).toBe('CONFIG_INVALID');
                expect(error.message).toContain('[worker.timeoutMs]');
                expect(error.context.reason).toContain('[worker.timeoutMs]');
            }
        });

        it('should throw when worker pool maxSize < initialSize', () => {
            const error = captureError(() => defineRuntimeConfig({
                worker: { pool: { initialSize: 10, maxSize: 5 } },
            }));
            expectConfigError(error, 'worker.pool.maxSize');
        });

        it('should validate multiple rules simultaneously', () => {
            const error = captureError(() => defineRuntimeConfig({
                worker: { timeoutMs: 0 },
                logger: { maxSystemLogs: 1 },
            }));
            expectConfigError(error, 'worker.timeoutMs');
            expect((error as AOTUIError).message).toContain('[logger.maxSystemLogs]');
        });

        it.each([
            ['worker.timeoutMs', (value: number) => ({ worker: { timeoutMs: value } }), 1_000, 300_000],
            ['logger.maxSystemLogs', (value: number) => ({ logger: { maxSystemLogs: value } }), 10, 10_000],
        ] as const)('rejects NaN at %s and accepts both bounds', (path, createInput, minimum, maximum) => {
            expectConfigError(captureError(() => defineRuntimeConfig(createInput(Number.NaN) as any)), path);
            expect(() => defineRuntimeConfig(createInput(minimum) as any)).not.toThrow();
            expect(() => defineRuntimeConfig(createInput(maximum) as any)).not.toThrow();
        });

        it('rejects non-numeric leaf values without invoking coercion hooks', () => {
            let valueOfCalls = 0;
            const value = { valueOf() { valueOfCalls++; return 60_000; } };
            const error = captureError(() => defineRuntimeConfig({ worker: { timeoutMs: value as any } }));
            expectConfigError(error, 'worker.timeoutMs');
            expect(valueOfCalls).toBe(0);
        });

        it.each([
            ['worker.timeoutMs', (value: unknown) => ({ worker: { timeoutMs: value } })],
            ['worker.pool.maxSize', (value: unknown) => ({ worker: { pool: { maxSize: value } } })],
            ['worker.pool.initialSize', (value: unknown) => ({ worker: { pool: { initialSize: value } } })],
            ['worker.pool.idleTimeoutMs', (value: unknown) => ({ worker: { pool: { idleTimeoutMs: value } } })],
            ['logger.maxSystemLogs', (value: unknown) => ({ logger: { maxSystemLogs: value } })],
        ] as const)('rejects non-numeric %s values without reading coercion properties', (path, createInput) => {
            let coercionReads = 0;
            const value = Object.defineProperty({}, 'valueOf', {
                get() {
                    coercionReads++;
                    return () => 2;
                },
            });
            const error = captureError(() => defineRuntimeConfig(createInput(value) as any));
            const configError = expectConfigError(error, path);
            expect(coercionReads).toBe(0);
            if (path === 'worker.pool.initialSize') {
                expect(configError.message).not.toContain('[worker.pool.maxSize]');
            }
        });

        it.each([
            ['logger.maxAppLogs', { logger: { maxAppLogs: 80 } }],
            ['bridge', { bridge: { debounceMs: 4321 } }],
            ['transform', { transform: { domThrottleMs: 900, maxTreeDepth: 10 } }],
        ] as const)('rejects obsolete %s options with a path-bearing CONFIG_INVALID', (path, input) => {
            expectConfigError(captureError(() => defineRuntimeConfig(input as any)), path);
        });

        it('rejects unknown nested worker keys while preserving supported worker/logger settings', () => {
            expectConfigError(captureError(() => defineRuntimeConfig({ worker: { pool: { typo: 1 } } } as any)), 'worker.pool.typo');
            expect(defineRuntimeConfig({ worker: { pool: { maxSize: 12 } }, logger: { maxSystemLogs: 80 } })).toMatchObject({
                worker: { pool: { maxSize: 12, initialSize: 2 } },
                logger: { maxSystemLogs: 80 },
            });
        });
    });
});
