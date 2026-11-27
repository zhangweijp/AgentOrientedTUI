export { createApp, createView } from './app-factory/createApp.js';
export type { AppAuthorContext, CreateAppConfig, TUIAppFactory, ViewHandle, ViewHandleIdentity, ViewFrame } from './app-factory/createApp.js';
export { ref, arrayRef, formatRef } from './app-factory/refs.js';
export type { PublishedRef, RefOptions, ArrayRefOptions } from './app-factory/refs.js';
export { defineViewType, refParam } from './tools/view-type-tool.js';
export type {
    ArgsOf, ContextualViewType, PlainViewType, ContextToolMetadata, DeepReadonly, JsonSchemaObject, RefParameter, ViewType,
} from './tools/view-type-tool.js';
export type { StandardJSONSchemaV1 } from './tools/schema-types.js';
export { AOTUIError, ViewRegion, ViewMultiplicity } from '@aotui/core';
export type {
    AppID, AppLifecycleCallbacks, DesktopID, JsonValue, PublishResult, PublishMode, ProjectionLimits, RefScope, ToolError, ToolResult,
} from '@aotui/core';
