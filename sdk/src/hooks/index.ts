/**
 * AOTUI SDK Hooks
 *
 * React-style hooks for AOTUI View development
 *
 * [重要] 应用开发者必须从 SDK 导入这些 hooks，而不是直接从 preact/hooks 导入。
 * 这确保所有 hooks 使用同一个 Preact 实例，避免多实例冲突。
 *
 * [RFC-002] useDataRef, useArrayRef 用于资源引用系统
 */

// Re-export Preact hooks to ensure single Preact instance
export {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useReducer,
} from "preact/hooks";

export {
  type IViewMeta,
  type IRefRegistry,
  type IAppConfig,
} from "../contexts/index.js";

export {
  ViewRuntimeContext,
  type ViewRuntimeContextValue,
} from "../contexts/view-runtime-context.js";

export { useViewSelector, useViewRuntimeContext } from "./use-view-selector.js";

// AOTUI Hooks
export {
  useViewContext,
  useRefRegistry,
} from "./useViewContext.js";

// [Configuration Injection] App Config Hooks
export { useAppConfig, useAppEnv } from "./useAppConfig.js";

// [Persistence] App state persistence
export { usePersistentState } from "./usePersistentState.js";

export { useDataRef, useEntityRef, type RefHandle } from "./useRef.js";
export {
  useArrayRef,
  type ArrayRefHandle,
  type ListRefFormatter,
  type ItemRefFormatter,
} from "./useArrayRef.js";

// Also export RegisterLinkOptions from contexts
export { type RegisterLinkOptions } from "../contexts/index.js";

// [RFC-011] LLM Output Channel Hooks
export {
  useLLMOutputChannel,
  useLLMOutputHistory,
  type LLMOutputChannelOptions,
} from "./useLLMOutputChannel.js";

// [RFC-011] LLM Output Channel Context Type
export { type ILLMOutputChannelContext } from "../contexts/view-runtime-context.js";

// [View Type Aggregation] Type-level Tool Hook
export {
  useViewTypeTool,
  type TypeToolOptions,
  type TypeToolHandler,
  type TypeToolUI,
  type TypeToolUIProps,
  type UseViewTypeToolResult,
} from "./useViewTypeTool.js";

export {experimental_useCreateIfAbsentTool,type RequiredStringParams,type RequiredStringArgs,type CreateIfAbsentHandler,type CreateIfAbsentToolOptions,type CreateIfAbsentOutcome,type CreateIfAbsentTerminal} from './useCreateIfAbsentTool.js';
export { experimental_useReadOnlyTool } from './useReadOnlyTool.js';
export type { OrdinaryParamDef, OrdinaryParams, ReadOnlyParams, SnapshotValueRefParamDef, ReadOnlyToolArgs, ReadOnlyToolOptions, ReadOnlyToolHandler } from './useReadOnlyTool.js';

export type { AppStatePersistence, StateBindingStatus, StateFlushReport, StateValue, StateIssue } from '@aotui/runtime/spi';
export type { PersistOptions, PersistStatus, PersistMeta } from './usePersistentState.js';


export { experimental_useAppLifecycle } from './useAppLifecycle.js';
export type { AppLifecycleCallbacks } from './useAppLifecycle.js';
