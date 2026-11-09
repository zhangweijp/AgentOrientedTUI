import { VIEW_TYPE_TOOL_PROTOCOL } from '../runtime/app-type-tools.interface.js';
import { APP_LIFECYCLE_PROTOCOL } from '../runtime/app-lifecycle.interface.js';
import { STATE_SESSION_PROTOCOL } from '../runtime/state-persistence.interface.js';
/** App module contract accepted by Runtime AppRegistry and Worker Runtime. */

import type { ComponentFactory } from '../component-factory.interface.js';
import type { AppKernelConfig } from './app-kernel.interface.js';

/**
 * The sole supported App factory: a component factory with its Kernel config.
 * Apps are created by Runtime from `kernelConfig`; factories do not create
 * separate `IAOTUIApp` instances.
 */
export interface TUIAppFactory extends ComponentFactory {
    readonly displayName: string;
    readonly kernelConfig: AppKernelConfig;
    readonly toolAuthoringProtocol: typeof VIEW_TYPE_TOOL_PROTOCOL;
    readonly persistenceSupport: typeof STATE_SESSION_PROTOCOL;
    readonly appLifecycleSupport: typeof APP_LIFECYCLE_PROTOCOL;
}

/** Recognizes the component factory contract emitted by `createTUIApp`. */
export function isTUIAppFactory(value: unknown): value is TUIAppFactory {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    try {
        const factory = Object.getOwnPropertyDescriptors(value);
        const displayName = factory.displayName;
        const kernelConfig = factory.kernelConfig;
        const initializeComponent = factory.initializeComponent;
        const persistenceSupport = factory.persistenceSupport;
        const appLifecycleSupport = factory.appLifecycleSupport;
        if (!displayName || !('value' in displayName) || typeof displayName.value !== 'string' || displayName.value.length === 0 ||
            !kernelConfig || !('value' in kernelConfig) || typeof kernelConfig.value !== 'object' ||
            kernelConfig.value === null || Array.isArray(kernelConfig.value) ||
            !initializeComponent || !('value' in initializeComponent) || typeof initializeComponent.value !== 'function' ||
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
