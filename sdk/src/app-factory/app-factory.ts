import { captureAppMetadata, VIEW_TYPE_TOOL_PROTOCOL, APP_LIFECYCLE_PROTOCOL, STATE_SESSION_PROTOCOL } from '@aotui/runtime/spi';
import type { AppKernelConfig, AppMetadata, TUIAppFactory } from '@aotui/runtime/spi';

export const VIEW_ID_PATTERN = /^[a-zA-Z0-9_]{2,15}$/;

export type AppConfig = Omit<AppMetadata, 'description'> &
    Pick<AppKernelConfig, 'onDelete' | 'onReinitialize' | 'launchConfig' | 'signalPolicy'>;

export function createAppFactory(config: AppConfig, initialize: TUIAppFactory['initialize']): TUIAppFactory {
    const metadata = captureAppMetadata(config);
    return {
        displayName: metadata.app_name,
        kernelConfig: {
            appName: metadata.app_name,
            name: metadata.app_name,
            ...(metadata.whatItIs === undefined ? {} : { whatItIs: metadata.whatItIs }),
            ...(metadata.whenToUse === undefined ? {} : { whenToUse: metadata.whenToUse }),
            ...(config.onDelete === undefined ? {} : { onDelete: config.onDelete }),
            ...(config.onReinitialize === undefined ? {} : { onReinitialize: config.onReinitialize }),
            ...(config.launchConfig === undefined ? {} : { launchConfig: config.launchConfig }),
            ...(config.signalPolicy === undefined ? {} : { signalPolicy: config.signalPolicy }),
        },
        toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL,
        persistenceSupport: STATE_SESSION_PROTOCOL,
        appLifecycleSupport: APP_LIFECYCLE_PROTOCOL,
        initialize,
    };
}
