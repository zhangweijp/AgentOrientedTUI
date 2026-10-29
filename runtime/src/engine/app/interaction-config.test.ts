import { expect, it } from 'vitest';
import { captureInteractionModes } from './interaction-config.js';
import { AppWorkerHost } from './worker-host.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { AppManager } from './manager.js';
import type { InteractionMode } from '../../spi/runtime/app-interaction.interface.js';

const modes: InteractionMode[] = ['ordinary-v1', 'ordinary-v2', 'snapshot-value-v1', 'snapshot-value-v2', 'create-if-absent-v1'];
const hostConfig = { appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', snapshotShadow: true, experimentalReadOnlyViewTools: true };

it('B2 C03/05 all 32 subsets capture canonical independent frozen arrays', () => {
    for (let mask = 0; mask < 32; mask++) {
        const wanted = modes.filter((_, index) => mask & 1 << index), input = [...wanted].reverse();
        const actual = captureInteractionModes({ experimentalInteractionModes: input });
        expect(actual).toEqual(wanted);expect(Object.isFrozen(actual)).toBe(true);expect(actual).not.toBe(input);
        input.push('ordinary-v1');expect(actual).toEqual(wanted);
    }
    expect(captureInteractionModes()).toBeUndefined();expect(captureInteractionModes({})).toBeUndefined();
    expect(captureInteractionModes({ experimentalInteractionModes: undefined })).toBeUndefined();
    expect(captureInteractionModes(Object.create({ experimentalInteractionModes: modes }))).toBeUndefined();
});

it('B2 C04 invalid values/descriptors never execute a getter or allocate metadata/AppID/Worker pool', () => {
    let getters = 0;
    const values = [null, true, 1, 'ordinary-v1', {}, ['unknown'], ['ordinary-v1', 'ordinary-v1'], Array(1), Array(6).fill('ordinary-v1'),
        [['ordinary-v1']], ['x'.repeat(300)], Object.assign(['ordinary-v1'], { extra: 1 }),
        Object.defineProperty([], '0', { enumerable: true, get() { getters++;return 'ordinary-v1'; } }),
        Object.defineProperty(['ordinary-v1'], '0', { value: 'ordinary-v1', enumerable: false })];
    const options: any[] = values.map(experimentalInteractionModes => ({ experimentalInteractionModes }));
    options.push(Object.defineProperty({}, 'experimentalInteractionModes', { enumerable: true, get() { getters++;return modes; } }),
        Object.defineProperty({}, 'experimentalInteractionModes', { value: modes, enumerable: false }));
    const manager = new AppManager({ id: 'd', logSystem() {} } as any);
    for (const input of options) {
        expect(() => captureInteractionModes(input)).toThrow('Invalid experimental interaction modes');
    }
    // Preserve descriptors when checking each allocation boundary.
    for (const input of options) {
        const merge = (base: object) => Object.defineProperties(base, Object.getOwnPropertyDescriptors(input));
        for (const run of [() => new WorkerSandbox(merge({ ...hostConfig }) as any), () => new AppWorkerHost(merge({ ...hostConfig }) as any),
            () => manager.registerPendingApp(merge({ modulePath: '/unused' }) as any)]) {
            try { run();throw Error('must reject'); } catch (error) { expect(error).toMatchObject({ code: 'INTERACTION_MODES_INVALID', message: 'Invalid experimental interaction modes' }); }
        }
    }
    expect(getters).toBe(0);expect(manager.getInstalledApps()).toEqual([]);
    expect(manager.registerPendingApp({ modulePath: '/unused' })).toBe('app_0');manager.cleanup();
});

it('B2 C03 legacy Host booleans keep their default and explicit [] takes precedence', () => {
    const legacy = new AppWorkerHost({ ...hostConfig, experimentalSnapshotValueRefExecution: true });
    expect((legacy as any).interactionModes).toEqual(['snapshot-value-v1']);
    const none = new AppWorkerHost({ ...hostConfig, experimentalSnapshotValueRefExecution: true, experimentalInteractionModes: [] });
    expect((none as any).interactionModes).toEqual([]);
    expect(() => new AppWorkerHost({ ...hostConfig, snapshotShadow: false, experimentalInteractionModes: ['ordinary-v1'] })).toThrow('Invalid experimental interaction modes');
    legacy.terminate();none.terminate();
});
