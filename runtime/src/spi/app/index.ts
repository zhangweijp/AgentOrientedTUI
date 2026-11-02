/** Public contracts shared by Runtime and SDK. */

export type { IAOTUIApp } from './app.interface.js';
export type {
    AppKernelConfig,
    SignalPolicy,
    AppReinitializeContext,
} from './app-kernel.interface.js';
export type { AppContext } from './store.interface.js';
export type { AppLaunchConfig } from './app-config.interface.js';
export type { TUIAppFactory } from './app-factory.interface.js';
export { isTUIAppFactory } from './app-factory.interface.js';
export type { IRefExporter } from './ref-exporter.interface.js';
export type { IViewMeta, IRefRegistry } from './public-types.js';
