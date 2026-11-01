/**
 * @aotui/sdk - component application entry for the current Preact Runtime.
 *
 * Start with README.md; docs/api-status.md lists exact capability conditions,
 * and docs/migration.md describes the View-local ordinary-v2 and snapshot-value-v2
 * contracts. Export presence does not grant execution permission.
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
  useAppLifecycle,
  // [Configuration Injection] App Config Hooks
  useAppConfig,
  useAppEnv,
  // [Persistence]
  usePersistentState,
  // [RFC-002] Resource Reference Hooks
  useDataRef,
  useArrayRef,
  // [RFC-003] Operation Hooks
  useViewTypeTool,  // View Type Tool Aggregation
  // [RFC-011] LLM Output Channel
  useLLMOutputChannel,
  useLLMOutputHistory,
} from "./hooks/index.js";

// Public app metadata/config and managed instance persistence; SDK internals stay private.
export { useAppRuntimeContext } from './context/AppRuntimeContext.js';
export type {
  // [RFC-003] Context Types
  IViewMeta,
  // [RFC-002] Ref Types
  RefHandle,
  ArrayRefHandle,
  ListRefFormatter,
  ItemRefFormatter,
  TypeToolUI,  // View Type Tool Aggregation
  UseViewTypeToolResult,  // View Type Tool Aggregation
  TypeToolOptions,  // View Type Tool Aggregation
  TypeToolHandler,  // View Type Tool Aggregation
  TypeToolArgs,
  SnapshotValueRefParamDef,
  DeepReadonly,
  AppLifecycleCallbacks,
} from "./hooks/index.js";

// [P0 FIX] Re-export LLM Output Channel types for App developers
export type { LLMOutputEvent, LLMOutputListener } from "@aotui/runtime/spi";
export type { AppReinitializeContext } from "@aotui/runtime/spi";

// ─────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────

export { escapeHtml, escapeJsonForAttr } from "./utils/index.js";

// [RFC-027] Component-Based App Factory
export {
  createTUIApp,
  type TUIAppConfig
} from './app-factory/createTUIApp.js';

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
 * This list intentionally contains only app-facing contracts used by the
 * component SDK. Runtime Context and registry ports stay internal.
 */
export type {
  // ID Types
  AppID,
  ViewID,
  DesktopID,
  // View Interfaces
  // Context
  AppContext,
} from "@aotui/runtime/spi";

export { AOTUIError } from "@aotui/runtime/spi";

export type { AppStatePersistence, StateValue, StateBindingStatus, StateFlushReport, StateIssue } from '@aotui/runtime/spi';
export type { PersistOptions, PersistStatus, PersistMeta } from './hooks/usePersistentState.js';
