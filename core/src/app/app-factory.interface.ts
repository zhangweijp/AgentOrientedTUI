import { APP_LIFECYCLE_PROTOCOL } from './app-lifecycle.interface.js';
import { STATE_SESSION_PROTOCOL } from './state-persistence.interface.js';
/** App module contract verified by Worker Runtime. */

import type { AppInstance, RuntimeContext } from './app-instance.interface.js';

export const VIEW_TYPE_TOOL_PROTOCOL = 'view-type-tools-v7' as const;

/** Static App definition loaded from the manifest entry. */
export interface TUIAppFactory {
    initialize(context: RuntimeContext): AppInstance | Promise<AppInstance>;
    readonly app_name: string;
    readonly toolAuthoringProtocol: typeof VIEW_TYPE_TOOL_PROTOCOL;
    readonly persistenceSupport?: typeof STATE_SESSION_PROTOCOL;
    readonly appLifecycleSupport: typeof APP_LIFECYCLE_PROTOCOL;
}

function matchesAuthoringProtocol(field: PropertyDescriptor | undefined): boolean {
    return !!field && 'value' in field && field.value === VIEW_TYPE_TOOL_PROTOCOL;
}

/** Recognizes the managed App factory contract. */
export function isTUIAppFactory(value: unknown): value is TUIAppFactory {
    return typeof readAppFactory(value) === 'object';
}

/** Check the factory export and retain the reason for Worker startup diagnostics. */
export function readAppFactory(value: unknown): TUIAppFactory |
    'APP_INVALID_EXPORT' | 'PERSISTENCE_UNAVAILABLE' | 'APP_AUTHORING_PROTOCOL_UNSUPPORTED' {
    if (typeof value !== 'object' || value === null) return 'APP_INVALID_EXPORT';
    try {
        const persistenceSupport = Object.getOwnPropertyDescriptor(value, 'persistenceSupport');
        if (persistenceSupport && (!('value' in persistenceSupport) || persistenceSupport.value !== STATE_SESSION_PROTOCOL))
            return 'PERSISTENCE_UNAVAILABLE';
        if (Array.isArray(value)) return 'APP_INVALID_EXPORT';
        const appName = Object.getOwnPropertyDescriptor(value, 'app_name');
        const initialize = Object.getOwnPropertyDescriptor(value, 'initialize');
        const appLifecycleSupport = Object.getOwnPropertyDescriptor(value, 'appLifecycleSupport');
        if (!appName || !('value' in appName) || typeof appName.value !== 'string' || appName.value.length === 0 ||
            !initialize || !('value' in initialize) || typeof initialize.value !== 'function' ||
            !appLifecycleSupport || !('value' in appLifecycleSupport) || appLifecycleSupport.value !== APP_LIFECYCLE_PROTOCOL) {
            return 'APP_INVALID_EXPORT';
        }
        return matchesAuthoringProtocol(Object.getOwnPropertyDescriptor(value, 'toolAuthoringProtocol'))
            ? value as TUIAppFactory : 'APP_AUTHORING_PROTOCOL_UNSUPPORTED';
    } catch {
        return 'APP_INVALID_EXPORT';
    }
}

/** Factory authoring capability, captured without invoking an accessor. */
export function hasViewTypeToolAuthoringProtocol(factory: unknown): boolean {
    if (factory === null || typeof factory !== 'object' || Array.isArray(factory)) return false;
    try {
        return matchesAuthoringProtocol(Object.getOwnPropertyDescriptor(factory, 'toolAuthoringProtocol'));
    } catch { return false; }
}
