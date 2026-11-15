import { captureAppMetadata, APP_LIFECYCLE_PROTOCOL, STATE_SESSION_PROTOCOL } from '@aotui/runtime/spi';
import type { AppKernelConfig, AppMetadata, TUIAppFactory } from '@aotui/runtime/spi';

import { captureViewTypes, SDK_VIEW_TYPE_PROTOCOL, toolDefinitions, type ViewType } from '../tools/view-type-tool.js';

export const VIEW_ID_PATTERN = /^[A-Za-z0-9_]+$/;

export type AppConfig = Omit<AppMetadata, 'description'> &
    Pick<AppKernelConfig, 'onDelete' | 'onReinitialize' | 'signalPolicy'> & { readonly viewTypes: readonly ViewType[] };

export function createAppFactory(
    config: AppConfig,
    initialize: (context: Parameters<TUIAppFactory['initialize']>[0], types: ReadonlyMap<string, ViewType>) => ReturnType<TUIAppFactory['initialize']>,
): TUIAppFactory {
    const metadata = captureAppMetadata(config);
    const types = captureViewTypes(config.viewTypes);
    const tools = toolDefinitions(types);
    return {
        kernelConfig: {
            appName: metadata.app_name,
            ...(metadata.whatItIs === undefined ? {} : { whatItIs: metadata.whatItIs }),
            ...(metadata.whenToUse === undefined ? {} : { whenToUse: metadata.whenToUse }),
            ...(config.onDelete === undefined ? {} : { onDelete: config.onDelete }),
            ...(config.onReinitialize === undefined ? {} : { onReinitialize: config.onReinitialize }),
            ...(config.signalPolicy === undefined ? {} : { signalPolicy: config.signalPolicy }),
        },
        toolAuthoringProtocol: SDK_VIEW_TYPE_PROTOCOL,
        persistenceSupport: STATE_SESSION_PROTOCOL,
        appLifecycleSupport: APP_LIFECYCLE_PROTOCOL,
        initialize(context) {
            if (context.appLifecycle?.protocol !== APP_LIFECYCLE_PROTOCOL)
                throw new Error('APP_LIFECYCLE_UNSUPPORTED');
            context.defineTools(tools);
            return initialize(context, types);
        },
    };
}
