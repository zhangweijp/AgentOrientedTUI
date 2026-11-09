/**
 * @aotui/sdk - component application entry for the current Preact Runtime.
 *
 * Start with README.md; docs/api-status.md lists exact capability conditions,
 * and docs/static-tools.md describes the current M1/M2 Tool contract. Export presence does not grant execution permission.
 *
 * @example
 * ```tsx
 * import { h } from 'preact';
 * import { createTUIApp, View } from '@aotui/sdk';
 * function Root() {
 *   return <View kind="instruction" id="root" type="Root" name="Root"><h1>Example</h1></View>;
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
export { createToolBindings, defineToolSet, defineViewTypeTool, getToolCatalog, refParam, TOOL_BINDING_DIAGNOSTIC_LIMITS } from './tools/view-type-tool.js';
export type {
    ToolBinding, ToolBindings, ToolBindingController, ToolBindingDiagnostics,
    ToolBindingErrorSummary, ToolBindingCleanupDiagnostic, ToolBindingErrorCode,
  ArgsOf,
  DeepReadonly,
  DefinedViewTypeTool,
  JsonSchemaObject,
  JsonSchemaValue,
  SchemaOf,
  ToolCatalogEntry,
  ToolSet,
  ToolSetMap,
  ViewTypeToolDeclaration,
} from './tools/view-type-tool.js';
export { useLLMOutputChannel } from './hooks/useLLMOutputChannel.js';
export type {
  AppID,
  ViewID,
  DesktopID,
  ToolError,
  ToolResult,
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

export { AppTools, ToolRef, ToolCatalog } from './components/AppTools.js';
export type { AppToolsProps, ToolRefProps, ToolCatalogProps } from './components/AppTools.js';
