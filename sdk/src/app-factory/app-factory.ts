import { AOTUIError, captureAppMetadata, APP_LIFECYCLE_PROTOCOL, STATE_SESSION_PROTOCOL, VIEW_TYPE_TOOL_PROTOCOL } from '@aotui/core';
import type { AppMetadata, TUIAppFactory as CoreAppFactory } from '@aotui/core';
import { captureViewTypes, viewTypeDefinitions, type ViewType } from '../tools/view-type-tool.js';

/** Lets author declaration emit name the factory through an SDK entry. */
export interface TUIAppFactory extends CoreAppFactory {}

export type AppConfig = Pick<AppMetadata, 'app_name'> & {
    readonly viewTypes: readonly ViewType[];
    readonly persistence?: boolean;
};

export function createAppFactory(
    config: AppConfig,
    initialize: (context: Parameters<TUIAppFactory['initialize']>[0], types: ReadonlyMap<string, ViewType>) => ReturnType<TUIAppFactory['initialize']>,
): TUIAppFactory {
    const { app_name } = captureAppMetadata({ app_name: Object.getOwnPropertyDescriptor(config, 'app_name')?.value });
    const persistence = Object.getOwnPropertyDescriptor(config, 'persistence');
    if (persistence && (!persistence.enumerable || !('value' in persistence) || typeof persistence.value !== 'boolean')) {
        const path = 'AppConfig.persistence';
        throw new AOTUIError('CONFIG_INVALID', { path, reason: `[${path}] Expected an enumerable boolean property` });
    }
    const usesPersistence = persistence?.value === true;
    const types = captureViewTypes(config.viewTypes);
    const definitions = viewTypeDefinitions(types);
    return {
        app_name,
        toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL,
        ...(usesPersistence ? { persistenceSupport: STATE_SESSION_PROTOCOL } : {}),
        appLifecycleSupport: APP_LIFECYCLE_PROTOCOL,
        initialize(context) {
            if (context.appLifecycle?.protocol !== APP_LIFECYCLE_PROTOCOL || typeof context.appLifecycle.register !== 'function')
                throw new Error('APP_LIFECYCLE_UNSUPPORTED');
            const { persistence, ...runtimeContext } = context;
            if (usesPersistence && (persistence?.protocol !== STATE_SESSION_PROTOCOL ||
                typeof persistence.instanceId !== 'string' || !persistence.instanceId ||
                typeof persistence.load !== 'function' || typeof persistence.save !== 'function' || typeof persistence.remove !== 'function' ||
                typeof persistence.flush !== 'function')) {
                throw Object.assign(new Error('persistence: true requires a Runtime that provides ' + STATE_SESSION_PROTOCOL),
                    { code: 'PERSISTENCE_UNAVAILABLE' });
            }
            context.defineViewTypes(definitions);
            return initialize(usesPersistence ? context : runtimeContext, types);
        },
    };
}
