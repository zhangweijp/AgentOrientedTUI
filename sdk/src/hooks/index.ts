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

export type { IViewMeta } from "@aotui/runtime/spi";

// AOTUI Hooks
export {
  useViewContext,
} from "./useViewContext.js";

// [Configuration Injection] App Config Hooks
export { useAppConfig, useAppEnv } from "./useAppConfig.js";

// [Persistence] App state persistence
export { usePersistentState } from "./usePersistentState.js";

export { useDataRef, type RefHandle } from "./useRef.js";
export {
  useArrayRef,
  type ArrayRefHandle,
  type ListRefFormatter,
  type ItemRefFormatter,
} from "./useArrayRef.js";

// [RFC-011] LLM Output Channel Hooks
export {
  useLLMOutputChannel,
  useLLMOutputHistory,
} from "./useLLMOutputChannel.js";

// View-local Tool Hook
export {
  useViewTypeTool,
  type TypeToolOptions,
  type TypeToolHandler,
  type TypeToolUI,
  type TypeToolUIProps,
  type UseViewTypeToolResult,
  type TypeToolArgs,
  type SnapshotValueRefParamDef,
  type DeepReadonly,
} from "./useViewTypeTool.js";

export type { StateBindingStatus, StateFlushReport, StateIssue } from '@aotui/runtime/spi';
export type { PersistOptions, PersistStatus, PersistMeta } from './usePersistentState.js';

export { useAppLifecycle } from './useAppLifecycle.js';
export type { AppLifecycleCallbacks } from './useAppLifecycle.js';
