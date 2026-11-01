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
export { useViewContext } from './hooks/useViewContext.js';
export { useViewTypeTool } from './hooks/useViewTypeTool.js';
export { useLLMOutputChannel } from './hooks/useLLMOutputChannel.js';
export type {
  TypeToolUI,
  UseViewTypeToolResult,
  TypeToolOptions,
  TypeToolHandler,
  TypeToolArgs,
  SnapshotValueRefParamDef,
  DeepReadonly,
} from './hooks/useViewTypeTool.js';
export type {
  ParamDef,
  ParamSchema,
  ParamType,
  ParamBaseType,
  ParamConstraints,
  InferArgs,
} from './operation/types.js';
export type {
  AppID,
  ViewID,
  DesktopID,
  OperationError,
  OperationResult,
  AppContext,
  AppReinitializeContext,
  IViewMeta,
  LLMOutputEvent,
  LLMOutputListener,
  AppStatePersistence,
  StateValue,
  StateBindingStatus,
  StateFlushReport,
  StateIssue,
} from '@aotui/runtime/spi';
export { AOTUIError } from '@aotui/runtime/spi';
