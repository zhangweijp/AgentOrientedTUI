import type { IRefRegistry } from '../app/ref-exporter.interface.js';

export interface MountedView extends Pick<IRefRegistry, 'registerRef'> {
    readonly owner: object;
    release(): void;
}
