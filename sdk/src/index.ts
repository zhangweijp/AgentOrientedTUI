/**
 * @aotui/sdk - component application entry for the current Preact Runtime.
 *
 * The package README shows how to build and run an App.
 *
 * Preact's useRef is a state hook; useDataRef declares application data references.
 */
export { StaticView, DynamicView, defineViewType, type ViewProps } from './components/View.js';
export { ViewRegion, ViewMultiplicity, type RefScope } from '@aotui/core';
export {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useReducer,
} from 'preact/hooks';
export { createTUIApp, type TUIAppConfig } from './app-factory/createTUIApp.js';
export type { TUIAppFactory } from './app-factory/app-factory.js';
export { useAppLifecycle, type AppLifecycleCallbacks } from './hooks/useAppLifecycle.js';
export { useAppRuntimeContext } from './context/AppRuntimeContext.js';
export { useDataRef, type RefHandle } from './hooks/useRef.js';
export {
  useArrayRef,
  type ArrayRefHandle,
  type ListRefFormatter,
  type ItemRefFormatter,
} from './hooks/useArrayRef.js';
export { refParam } from './tools/view-type-tool.js';
export type {
  ArgsOf,
  DeepReadonly,
  JsonSchemaObject,
  ViewType,
  ContextualViewType,
  ContextToolMetadata,
} from './tools/view-type-tool.js';
export type {
  AppID,
  DesktopID,
  ToolError,
  ToolResult,
  AppContext,
  ProjectionLimits,
  AppStatePersistence,
  StateValue,
  StatePersistenceOptions,
  StateFlushReport,
  StateIssue,
} from '@aotui/core';
export { AOTUIError } from '@aotui/core';

export { formatRef } from './app-factory/refs.js';
export type { RefOptions } from './app-factory/refs.js';
