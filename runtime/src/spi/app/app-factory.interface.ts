import { VIEW_TYPE_TOOL_PROTOCOL } from '../runtime/app-type-tools.interface.js';
import { APP_LIFECYCLE_PROTOCOL } from '../runtime/app-lifecycle.interface.js';
import { STATE_SESSION_PROTOCOL } from '../runtime/state-persistence.interface.js';
/** App module contract accepted by Runtime AppRegistry and Worker Runtime. */

import type { AppInstance, RuntimeContext } from './app-instance.interface.js';
import type { AppKernelConfig } from './app-kernel.interface.js';

/** Static App definition loaded from the manifest entry. */
export interface TUIAppFactory {
    initialize(context: RuntimeContext): AppInstance | Promise<AppInstance>;
    readonly displayName: string;
    readonly kernelConfig: AppKernelConfig;
    readonly toolAuthoringProtocol: typeof VIEW_TYPE_TOOL_PROTOCOL;
    readonly persistenceSupport: typeof STATE_SESSION_PROTOCOL;
    readonly appLifecycleSupport: typeof APP_LIFECYCLE_PROTOCOL;
}

/** Recognizes the managed App factory contract. */
export function isTUIAppFactory(value: unknown): value is TUIAppFactory {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    try {
        const factory = Object.getOwnPropertyDescriptors(value);
        const displayName = factory.displayName;
        const kernelConfig = factory.kernelConfig;
        const initialize = factory.initialize;
        const persistenceSupport = factory.persistenceSupport;
        const appLifecycleSupport = factory.appLifecycleSupport;
        if (!displayName || !('value' in displayName) || typeof displayName.value !== 'string' || displayName.value.length === 0 ||
            !kernelConfig || !('value' in kernelConfig) || typeof kernelConfig.value !== 'object' ||
            kernelConfig.value === null || Array.isArray(kernelConfig.value) ||
            !initialize || !('value' in initialize) || typeof initialize.value !== 'function' ||
            !persistenceSupport || !('value' in persistenceSupport) || persistenceSupport.value !== STATE_SESSION_PROTOCOL ||
            !appLifecycleSupport || !('value' in appLifecycleSupport) || appLifecycleSupport.value !== APP_LIFECYCLE_PROTOCOL) {
            return false;
        }

        const appName = Object.getOwnPropertyDescriptor(kernelConfig.value, 'appName');
        return !!appName && 'value' in appName && typeof appName.value === 'string' && appName.value.length > 0;
    } catch {
        return false;
    }
}

/** Factory authoring capability, captured without invoking an accessor. */
export function hasViewTypeToolAuthoringProtocol(factory: unknown): boolean {
    if (factory === null || typeof factory !== 'object' || Array.isArray(factory)) return false;
    try {
        const field = Object.getOwnPropertyDescriptor(factory, 'toolAuthoringProtocol');
        return !!field && 'value' in field && field.value === VIEW_TYPE_TOOL_PROTOCOL;
    } catch { return false; }
}
