/**
 * AOTUI SDK - App Runtime Context
 * 
 * App-level Runtime context supplied to the full managed component tree.
 * 
 * Supplies app metadata, App-owned Tool registration, View mount identities, and Ref publication ports.
 */

import type { AppLifecyclePort } from '@aotui/runtime/spi';
import type { AppStatePersistence } from '@aotui/runtime/spi';
import { createContext } from 'preact';
import { useContext, useMemo } from 'preact/hooks';
import type { AppID, DesktopID, IRefExporter, IProjectionPort, IViewOwnedToolPort, IAppTypeToolPort, AppLaunchConfig } from '@aotui/runtime/spi';

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

/**
 * App Runtime Context Value
 * 
 * 由AppKernel在initializeFromComponent时创建并提供给App及其View组件树
 */
interface AppRuntimeContextValue {
    persistence?: AppStatePersistence | undefined;
    appLifecycle?: AppLifecyclePort | undefined;
    /** App ID */
    appId: AppID;

    /** Desktop ID */
    desktopId: DesktopID;

    /** App 启动配置 */
    launchConfig?: AppLaunchConfig | undefined;

    /**
     * RefExporter访问 (用于useRef/useArrayRef)
     */
    refExporter: IRefExporter;

    /**
     * 标记App为脏状态 (触发重新渲染)
     */
    markDirty: () => void;

    /** Semantic commit coordination supplied by Runtime. */
    projection: IProjectionPort;

    /** SDK renderer retries only controller cleanups that have failed. */
    toolCleanup?: Set<() => void> | undefined;

    /** Managed renderer owns these callbacks even when Preact skips child cleanup. */
    toolOwners?: { closed: boolean; active: Set<() => void> } | undefined;

    /** View mount identities activate the App's shared ViewType Tools. */
    viewTools?: IViewOwnedToolPort | undefined;

    /** App-owned, ViewType-scoped ordinary Tool registration port. */
    appTypeTools?: IAppTypeToolPort | undefined;
}

interface AppRuntimePublicContextValue {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig | undefined;
    readonly persistence?: AppStatePersistence;
}

// ═══════════════════════════════════════════════════════════════
//  Context
// ═══════════════════════════════════════════════════════════════

/**
 * App Runtime Context
 * 
 * 由AppKernel的Provider在根组件包裹时提供
 */
export const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null);

// [RFC-027-C] Factory Injection Pattern:
// Context不再通过globalThis/Symbol注册，而是由Factory内部直接使用。

// ═══════════════════════════════════════════════════════════════
//  Hook
// ═══════════════════════════════════════════════════════════════

/**
 * 使用App Runtime Context
 * 
 * @throws 如果不在AppRuntimeContext.Provider内调用
 */
export function useInternalAppRuntimeContext(): AppRuntimeContextValue {
    const ctx = useContext(AppRuntimeContext);

    if (!ctx) {
        throw new Error(
            '[AOTUI SDK] useAppRuntimeContext must be used within a managed App component.'
        );
    }

    return ctx;
}

/**
 * Read app metadata, launch configuration and the managed instance persistence
 * client port. SDK-owned registries and lifecycle ports are kept internal.
 */
export function useAppRuntimeContext(): AppRuntimePublicContextValue {
    const context = useInternalAppRuntimeContext();
    return useMemo(() => {
        const persistence = context.persistence;
        return Object.freeze({
            appId: context.appId,
            desktopId: context.desktopId,
            ...(context.launchConfig === undefined ? {} : { launchConfig: context.launchConfig }),
            ...(persistence === undefined ? {} : { persistence }),
        });
    }, [context]);
}
