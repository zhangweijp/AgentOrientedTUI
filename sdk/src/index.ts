/**
 * @aotui/sdk - component application entry for the current Preact Runtime.
 *
 * The package README shows how to build and run an App.
 *
 * Preact's useRef is a state hook; useDataRef declares application data references.
 */
export { View, type ViewProps } from './components/View.js';
export {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useReducer,
} from 'preact/hooks';
export { createTUIApp, type TUIAppConfig } from './app-factory/createTUIApp.js';
export { useAppLifecycle, type AppLifecycleCallbacks } from './hooks/useAppLifecycle.js';
export { useAppRuntimeContext } from './context/AppRuntimeContext.js';
export { usePersistentState, type PersistOptions, type PersistStatus, type PersistMeta } from './hooks/usePersistentState.js';
export { useDataRef, type RefHandle } from './hooks/useRef.js';
export {
  useArrayRef,
  type ArrayRefHandle,
  type ListRefFormatter,
  type ItemRefFormatter,
} from './hooks/useArrayRef.js';
export { defineViewType, getToolCatalog, refParam } from './tools/view-type-tool.js';
export type {
  ArgsOf,
  DeepReadonly,
  JsonSchemaObject,
  ViewType,
  ContextualViewType,
  ToolCatalogEntry,
} from './tools/view-type-tool.js';
export { useLLMUsage } from './hooks/useLLMUsage.js';
export type {
  AppID,
  DesktopID,
  ToolError,
  ToolResult,
  AppContext,
  AppReinitializeContext,
  LLMUsageEvent,
  ProjectionLimits,
  AppStatePersistence,
  StateValue,
  StateBindingStatus,
  StateFlushReport,
  StateIssue,
} from '@aotui/runtime/spi';
export { AOTUIError } from '@aotui/runtime/spi';

export { ToolCatalog } from './components/ToolCatalog.js';
export type { ToolCatalogProps } from './components/ToolCatalog.js';

export { formatRef } from './app-factory/refs.js';
export type { RefOptions } from './app-factory/refs.js';
