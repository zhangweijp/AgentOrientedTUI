/**
 * SPI Layer - Kernel Interfaces
 * 
 * Defines the Kernel and Desktop runtime contracts.
 */

import type { DesktopID, AppID } from '@aotui/core';
import type { UpdateSignal } from '../core/signals.js';
import type { AppCloseHandle, DesktopCloseHandle, RuntimeCloseHandle } from './close.interface.js';
import type { AppInteractionOptions } from './app-interaction.interface.js';
import type { ActiveTurn as CoreTurn, AppInteractionPolicy, AppInvocation, AppPreviewResult, CancellationSignal,
    InteractionIssue, InvokeResult as CoreInvokeResult, PrepareObservationResult, ObservationOptions,
    ReceiptAccess as CoreReceiptAccess, ReceiptQuery, TurnSelection } from '@aotui/core';
import type { AppWindowTarget, AppWindows, ViewWindowTarget } from './windows.js';

type PendingAppMetadata = Readonly<{ name: string; description?: string; whatItIs?: string; whenToUse?: string }>;
export type RegisterPendingAppOptions = AppInteractionOptions & {
    installationId: string;
    config?: import('@aotui/core').AppLaunchConfig;
} & (
    | Readonly<{ localPath: string; backend?: string; command?: never; name?: never }>
    | (PendingAppMetadata & Readonly<{ command: readonly string[]; backend?: never; localPath?: never }>)
    | (PendingAppMetadata & Readonly<{ backend: string; command?: never; localPath?: never }>)
);

export interface AppPolicyTarget {
    readonly desktopId: DesktopID;
    readonly appId: AppID;
    readonly installationId: string;
    readonly name: string;
}
export interface CreateDesktopOptions {
    readonly id?: DesktopID;
    readonly policyForApp?: (app: AppPolicyTarget) => AppInteractionPolicy;
}
export interface OpenAppOptions { readonly policy?: AppInteractionPolicy }

export interface RunningApp {
    readonly appId: AppID;
    readonly instanceId: string;
    observe(options?: ObservationOptions): Promise<PrepareObservationResult>;
    preview(): Promise<AppPreviewResult>;
    readReceipt(query: ReceiptQuery, timeoutMs?: number): Promise<ReceiptAccess>;
    beginClose(): AppCloseHandle;
}

export type CandidateScope = {
    observe(app: Pick<RunningApp, 'observe'>, options?: ObservationOptions): Promise<PrepareObservationResult>;
    discard(): readonly InteractionIssue[];
} & (typeof Symbol extends { readonly dispose: infer Key extends symbol }
    ? { [K in Key]: () => void }
    : unknown);

export type RunningAppResult = Readonly<{ status: 'ready'; app: RunningApp }> |
    Readonly<{ status: 'rejected'; issue: InteractionIssue }>;

export interface ReceiptLocator extends ReceiptQuery {
    readonly desktopId: DesktopID;
    readonly appId: AppID;
    readonly instanceId: string;
}
export type ReceiptAccess = (Omit<Extract<CoreReceiptAccess, {kind:'receipt'}>, 'locator'> & Readonly<{locator: ReceiptLocator}>) |
    (Omit<Extract<CoreReceiptAccess, {kind:'unavailable'}>, 'locator'> & Readonly<{locator?: ReceiptLocator}>);
export type InvokeResult = ReceiptAccess | Extract<CoreInvokeResult, {kind:'refused'}>;
export interface CloseViewRequest { readonly turn: ActiveTurn; readonly target: ViewWindowTarget; readonly invocationId: string; }
export interface CloseViewOptions { readonly timeoutMs?: number; readonly signal?: CancellationSignal; }
export interface ActiveTurn extends Omit<CoreTurn, 'invoke'> {
    invoke(appId: string, request: AppInvocation, timeoutMs?: number, signal?: CancellationSignal): Promise<InvokeResult>;
}
export type AdoptTurnResult = Readonly<{ status: 'adopted'; turn: ActiveTurn; cleanupIssues: readonly InteractionIssue[] }> |
    Readonly<{ status: 'rejected'; issue: InteractionIssue }>;

export interface AppRunFacts {
    readonly phase: 'starting' | 'opened' | 'closing';
    readonly execution: Readonly<{
        resource: 'not-created' | 'owned' | 'retiring' | 'exited';
        channel: 'not-established' | 'open' | 'ended';
        issue?: InteractionIssue;
    }>;
    readonly projection: Readonly<{
        health: 'unready' | 'ready' | 'degraded' | 'stopped';
        issue?: InteractionIssue;
    }>;
    readonly availability: Readonly<{ status: 'ready' } | { status: 'unavailable'; issue: InteractionIssue }>;
    readonly toolsEnabled: boolean;
    readonly resourcesReleased: boolean;
}

export interface AppDiscoveryInfo {
    readonly installationId: string;
    readonly appId?: AppID;
    /** Runtime-owned identity of the current App execution, absent when no instance is open. */
    readonly appInstanceId?: string;
    readonly name: string;
    readonly status: 'pending' | 'running' | 'closed';
    readonly run?: AppRunFacts;
    readonly description?: string;
    readonly whatItIs?: string;
    readonly whenToUse?: string;
}

export interface IDesktop {
    getRunningApp(appId: string, expectedInstanceId: string): RunningAppResult;
    createCandidateScope(): CandidateScope;
    adoptTurn(input: TurnSelection): AdoptTurnResult;
    readReceipt(locator: ReceiptLocator, timeoutMs?: number): Promise<ReceiptAccess>;
    beginClose(): DesktopCloseHandle;
    beginCloseApp(appId: string, expectedInstanceId: string): AppCloseHandle;
    readonly id: DesktopID;
    /** True from close admission onward, including after resources have been released. */
    readonly isClosing: boolean;

    /** Installed application catalog used by Semantic context and lifecycle controls. */
    listApps(): readonly AppDiscoveryInfo[];
    /** Optional, bounded by the adapter when projecting recent Desktop activity. */
    getSystemLogs?(): readonly { timestamp: number; message: string }[];

    /**
     * [Worker-Only] 安装 App
     * 
     * App 运行在独立的 Worker Thread 中。
     * 
     */
    installDynamicWorkerApp(
        appModulePath: string,
        options?: AppInteractionOptions & OpenAppOptions & {
            installationId?: string;
            name?: string;
            /** [RFC-013] App description for Agent */
            description?: string;
            whatItIs?: string;
            whenToUse?: string;
            config?: import('@aotui/core').AppLaunchConfig;
        }
    ): Promise<RunningApp>;

    /**
     * [RFC-014] 注册待启动 App (懒加载)
     * 
     * App 信息写入 installedApps，但不启动 Worker。
     * Semantic context can present these apps and expose the corresponding open control.
     */
    registerPendingApp(options: RegisterPendingAppOptions): Promise<string>;

    // System Commands (App)
    openApp(installationId: string, options?: OpenAppOptions): Promise<RunningApp>;
    getAppWindows(appId: AppID, expectedInstanceId: string): AppWindows | undefined;
    revokeWindowAccess(turn: ActiveTurn, target: AppWindowTarget | ViewWindowTarget, channel?: 'body' | 'close' | 'all'): void;
    closeView(request: CloseViewRequest, options?: CloseViewOptions): Promise<InvokeResult>;

    output: {
        subscribe(listener: (signal: UpdateSignal) => void): void;
        unsubscribe(listener: (signal: UpdateSignal) => void): void;
    };
}

// ============================================================================
// Kernel Interface
// ============================================================================

/**
 * Kernel 接口
 * 
 * Runtime 的核心编排器。
 */
export interface IKernel {
    beginClose(): RuntimeCloseHandle;
    createDesktop(options?: DesktopID | CreateDesktopOptions): Promise<IDesktop>;

    /**
     * 获取 Desktop 实例
     * @throws {AOTUIError} DESKTOP_NOT_FOUND if the Desktop does not exist.
     */
    getDesktop(desktopId: DesktopID): IDesktop;
}
