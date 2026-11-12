import { expect, it } from 'vitest';
import { captureInteractionModes } from './interaction-config.js';
import { AppWorkerHost } from './worker-host.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { AppManager } from './manager.js';
import type { InteractionMode } from '../../spi/runtime/app-interaction.interface.js';

const modes: InteractionMode[] = ['view-type-parameters-v1'];
const hostConfig = { appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused' };

it('C05 all supported current subsets capture canonical independent frozen arrays', () => {
    for (let mask = 0; mask < 2; mask++) {
        const wanted = modes.filter((_, index) => mask & 1 << index), input = [...wanted].reverse();
        const actual = captureInteractionModes({ interactionModes: input });
        expect(actual).toEqual(wanted);expect(Object.isFrozen(actual)).toBe(true);expect(actual).not.toBe(input);
        input.push('view-type-parameters-v1');expect(actual).toEqual(wanted);
    }
    expect(captureInteractionModes()).toBeUndefined();expect(captureInteractionModes({})).toBeUndefined();
    expect(captureInteractionModes({ interactionModes: undefined })).toBeUndefined();
    expect(captureInteractionModes(Object.create({ interactionModes: modes }))).toBeUndefined();
});

it('C05 invalid values/descriptors never execute a getter or allocate metadata/AppID/Worker pool', async () => {
    let getters = 0;
    const values = [['ordinary-v2'], ['snapshot-value-v2'], null, true, 1, 'view-type-parameters-v1', {}, ['unknown'], ['view-type-parameters-v1', 'view-type-parameters-v1'], Array(1), Array(3).fill('view-type-parameters-v1'),
        [['view-type-parameters-v1']], ['x'.repeat(300)], Object.assign(['view-type-parameters-v1'], { extra: 1 }),
        Object.defineProperty([], '0', { enumerable: true, get() { getters++;return 'view-type-parameters-v1'; } }),
        Object.defineProperty(['view-type-parameters-v1'], '0', { value: 'view-type-parameters-v1', enumerable: false })];
    const options: any[] = values.map(interactionModes => ({ interactionModes }));
    options.push(Object.defineProperty({}, 'interactionModes', { enumerable: true, get() { getters++;return modes; } }),
        Object.defineProperty({}, 'interactionModes', { value: modes, enumerable: false }));
    const manager = new AppManager({ id: 'd', logSystem() {} } as any);
    for (const input of options) {
        expect(() => captureInteractionModes(input)).toThrow('Invalid interaction modes');
    }
    // Preserve descriptors when checking each allocation boundary.
    for (const input of options) {
        const merge = (base: object) => Object.defineProperties(base, Object.getOwnPropertyDescriptors(input));
        for (const run of [() => new WorkerSandbox(merge({ ...hostConfig }) as any), () => new AppWorkerHost(merge({ ...hostConfig }) as any),
            () => manager.registerPendingApp(merge({ modulePath: '/unused' }) as any)]) {
            try { run();throw Error('must reject'); } catch (error) { expect(error).toMatchObject({ code: 'INTERACTION_MODES_INVALID', message: 'Invalid interaction modes' }); }
        }
    }
    expect(getters).toBe(0);expect(manager.getInstalledApps()).toEqual([]);
    expect(manager.registerPendingApp({ modulePath: '/unused' })).toBe('app_0');await manager.cleanupAsync();
});
