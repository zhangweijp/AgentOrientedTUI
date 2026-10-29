/**
 * @aotui/sdk - component application entry for the current Preact Runtime.
 *
 * Start with README.md; docs/api-status.md lists exact capability conditions,
 * and docs/migration.md separates legacy parameter behavior from the experimental
 * readonly contracts. Export presence does not grant execution permission.
 *
 * @example
 * ```tsx
 * import { h } from 'preact';
 * import { createTUIApp, View } from '@aotui/sdk';
 * function Root() {
 *   return <View id="root" type="Root" name="Root"><h1>Example</h1></View>;
 * }
 * export default createTUIApp({ app_name: 'example', component: Root });
 * ```
 *
 * useRef is the Preact Hook; useDataRef declares application data references.
 * New readonly/creation tools remain experimental.
 */

// ─────────────────────────────────────────────────────────────
//  Components
// ─────────────────────────────────────────────────────────────

export { View } from "./components/index.js";
export type { ViewProps } from "./components/index.js";

// Tool Params (SSOT in operation/)
export { defineParams } from "./operation/defineParams.js";
export type {
  OperationResult,
  OperationError,
  ParamDef,
  ParamSchema,
  ParamType,
  ParamBaseType,
  ParamConstraints,
  InferArgs,
} from "./operation/types.js";

// ─────────────────────────────────────────────────────────────
//  Hooks
// ─────────────────────────────────────────────────────────────

export {
  // Preact hooks (re-exported to avoid multi-instance issues)
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useReducer,
  // AOTUI hooks
  useViewContext,
  useRefRegistry,
  // [Configuration Injection] App Config Hooks
  useAppConfig,
  useAppEnv,
  // [Persistence]
  usePersistentState,
  // [RFC-002] Resource Reference Hooks
  useDataRef,
  useEntityRef,
  useArrayRef,
  // [RFC-003] Operation Hooks
  useViewTypeTool,  // View Type Tool Aggregation
  // [RFC-011] LLM Output Channel
  useLLMOutputChannel,
  useLLMOutputHistory,
} from "./hooks/index.js";
export type {
  // [RFC-003] Context Types
  IViewMeta,
  IRefRegistry,
  IAppConfig,
  // [RFC-002] Ref Types
  RefHandle,
  ArrayRefHandle,
  ListRefFormatter,
  ItemRefFormatter,
  TypeToolUI,  // View Type Tool Aggregation
  UseViewTypeToolResult,  // View Type Tool Aggregation
  TypeToolOptions,  // View Type Tool Aggregation
  TypeToolHandler,  // View Type Tool Aggregation
  // [RFC-011]
  ILLMOutputChannelContext,
  LLMOutputChannelOptions,
} from "./hooks/index.js";

// [P0 FIX] Re-export LLM Output Channel types for App developers
export type { LLMOutputEvent, LLMOutputListener } from "@aotui/runtime/spi";
export type { AppReinitializeContext } from "@aotui/runtime/spi";

// ─────────────────────────────────────────────────────────────
//  Adapter (Component Mode Only)
// ─────────────────────────────────────────────────────────────

// [RFC-027] Inline View for component mode
export { createInlineView } from "./adapter/index.js";
export type { InlineViewConfig } from "./adapter/index.js";

// ─────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────

export { escapeHtml, escapeJsonForAttr } from "./utils/index.js";

// [RFC-027] Component-Based App Factory
export {
  createTUIApp,
  type TUIAppConfig,
  type TUIComponentAppFactory
} from './app-factory/createTUIApp.js';

// [RFC-027] App Runtime Context (for component-based apps)
export {
  AppRuntimeContext,
  useAppRuntimeContext,
  type AppRuntimeContextValue,
} from './context/AppRuntimeContext.js';

// ─────────────────────────────────────────────────────────────
//  Factory Utilities (Phase 2 Task 2.2)
// ─────────────────────────────────────────────────────────────

export {
  TUI_FACTORY,
  isFactory,
  isViewFactory,
  isAppFactory,
  createCallableFactory,
} from "./factory/index.js";
export type { Factory, FactoryType } from "./factory/index.js";

// ─────────────────────────────────────────────────────────────
//  Runtime Types Re-export
// ─────────────────────────────────────────────────────────────
/**
 * [P1 FIX] Re-export commonly needed Runtime types.
 *
 * This enables developers to import everything from @aotui/sdk:
 * ```typescript
 * import {
 *     createTUIApp, View, useArrayRef, defineParams, useViewTypeTool,
 *     type AppID, type ViewID, type OperationResult
 * } from '@aotui/sdk';
 * ```
 *
 * For advanced integration (Bridge, LLM tools, Kernel),
 * import directly from @aotui/runtime.
 */
export type {
  // ID Types
  AppID,
  ViewID,
  DesktopID,
  SnapshotID,
  OperationID,
  // App Interface
  IAOTUIApp,
  // View Interfaces
  // Context
  AppContext,
} from "@aotui/runtime/spi";

// Type guard for IViewContextMountable features
export { hasMountableSupport, AOTUIError } from "@aotui/runtime/spi";

export {experimental_useCreateIfAbsentTool,type RequiredStringParams,type RequiredStringArgs,type CreateIfAbsentHandler,type CreateIfAbsentToolOptions,type CreateIfAbsentOutcome,type CreateIfAbsentTerminal} from './hooks/useCreateIfAbsentTool.js';
export { experimental_useReadOnlyTool } from './hooks/useReadOnlyTool.js';
export type { OrdinaryParamDef, OrdinaryParams, ReadOnlyParams, SnapshotValueRefParamDef, ReadOnlyToolArgs, ReadOnlyToolOptions, ReadOnlyToolHandler } from './hooks/useReadOnlyTool.js';

export type { AppStatePersistence, StateBindingStatus, StateFlushReport, StateValue, StateIssue } from '@aotui/runtime/spi';
export type { PersistOptions, PersistStatus, PersistMeta } from './hooks/usePersistentState.js';


export { experimental_useAppLifecycle } from './hooks/useAppLifecycle.js';
export type { AppLifecycleCallbacks } from './hooks/useAppLifecycle.js';
