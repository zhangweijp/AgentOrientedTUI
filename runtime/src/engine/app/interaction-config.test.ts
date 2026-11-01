import { expect, it } from 'vitest';
import { captureInteractionModes } from './interaction-config.js';
import { AppWorkerHost } from './worker-host.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { AppManager } from './manager.js';
import type { InteractionMode } from '../../spi/runtime/app-interaction.interface.js';

const modes: InteractionMode[] = ['ordinary-v2', 'snapshot-value-v2'];
const hostConfig = { appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused' };

it('C05 all supported V2 subsets capture canonical independent frozen arrays', () => {
    for (let mask = 0; mask < 4; mask++) {
        const wanted = modes.filter((_, index) => mask & 1 << index), input = [...wanted].reverse();
        const actual = captureInteractionModes({ interactionModes: input });
        expect(actual).toEqual(wanted);expect(Object.isFrozen(actual)).toBe(true);expect(actual).not.toBe(input);
        input.push('ordinary-v2');expect(actual).toEqual(wanted);
    }
    expect(captureInteractionModes()).toBeUndefined();expect(captureInteractionModes({})).toBeUndefined();
    expect(captureInteractionModes({ interactionModes: undefined })).toBeUndefined();
    expect(captureInteractionModes(Object.create({ interactionModes: modes }))).toBeUndefined();
});

it('C05 invalid values/descriptors never execute a getter or allocate metadata/AppID/Worker pool', () => {
    let getters = 0;
    const values = [null, true, 1, 'ordinary-v2', {}, ['unknown'], ['ordinary-v2', 'ordinary-v2'], Array(1), Array(3).fill('ordinary-v2'),
        [['ordinary-v2']], ['x'.repeat(300)], Object.assign(['ordinary-v2'], { extra: 1 }),
        Object.defineProperty([], '0', { enumerable: true, get() { getters++;return 'ordinary-v2'; } }),
        Object.defineProperty(['ordinary-v2'], '0', { value: 'ordinary-v2', enumerable: false })];
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
    expect(manager.registerPendingApp({ modulePath: '/unused' })).toBe('app_0');manager.cleanup();
});

it('C05 missing config defaults to both V2 channels while explicit [] disables both', () => {
    const defaults = new AppWorkerHost(hostConfig);
    expect((defaults as any).interactionModes).toEqual(modes);
    const none = new AppWorkerHost({ ...hostConfig, interactionModes: [] });
    expect((none as any).interactionModes).toEqual([]);
    expect(() => new AppWorkerHost({ ...hostConfig, interactionModes: ['ordinary-v1'] as any })).toThrow('Invalid interaction modes');
    defaults.terminate();none.terminate();
});
