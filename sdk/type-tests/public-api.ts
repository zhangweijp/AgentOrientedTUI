import Type from 'typebox';
import {
  createTUIApp,
  StaticView,
  DynamicView,
  useAppLifecycle,
  useAppRuntimeContext,
  useArrayRef,
  useDataRef,
  defineViewType,
  refParam,
  type AppLifecycleCallbacks,
  type AppContext,
  type AppStatePersistence,
  type AppID,
  type ArrayRefHandle,
  type DeepReadonly,
  type DesktopID,
  type ArgsOf,
  type ItemRefFormatter,
  type ListRefFormatter,
  type ProjectionLimits,
  type ToolError,
  type ToolResult,
  type RefHandle,
  type StatePersistenceOptions,
  type StateFlushReport,
  type StateIssue,
  type StateValue,
  type TUIAppConfig,
  type ViewType,
  type ViewProps,
} from '@aotui/sdk';
import { arrayRef, formatRef, ref, type ArrayRefOptions, type RefOptions } from '@aotui/sdk/app';

import './view-type-tool.js';

import type {
  ToolError as RuntimeToolError,
  ToolResult as RuntimeToolResult,
} from '@aotui/core';

// @ts-expect-error The Context object is private SDK plumbing.
import { ViewRuntimeContext } from '@aotui/sdk';
// @ts-expect-error The full SDK Context accessor is private.
import { useInternalAppRuntimeContext } from '@aotui/sdk';

void ViewRuntimeContext;
void useInternalAppRuntimeContext;
type PublicAppRuntimeContext = ReturnType<typeof useAppRuntimeContext>;
type InternalContextKeys = Extract<keyof PublicAppRuntimeContext,
  'refExporter' | 'markDirty' | 'projection' | 'viewTools' | 'appTypeTools' | 'appLifecycle'>;
type AssertNever<Value extends never> = Value;
type AssertTrue<Value extends true> = Value;
type NoInternalContextPorts = AssertNever<InternalContextKeys>;
type PublicPersistence = NonNullable<PublicAppRuntimeContext['persistence']>;
type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
type SDKToolResultIsRuntimeResult = AssertTrue<Equal<ToolResult, RuntimeToolResult>>;
type SDKToolErrorIsRuntimeError = AssertTrue<Equal<ToolError, RuntimeToolError>>;
const publicPersistenceIsTheManagedPort: AssertTrue<Equal<PublicPersistence, AppStatePersistence>> = true;
const toolResultIsRuntimeResult: SDKToolResultIsRuntimeResult = true;
const toolErrorIsRuntimeError: SDKToolErrorIsRuntimeError = true;
type PublicContextChecks = [NoInternalContextPorts, typeof publicPersistenceIsTheManagedPort,
  typeof toolResultIsRuntimeResult, typeof toolErrorIsRuntimeError];
function checkPublicContextShape() {
  const context = useAppRuntimeContext();
  const appId: AppID = context.appId;
  const desktopId: DesktopID = context.desktopId;
  const launchConfig: Record<string, unknown> | undefined = context.launchConfig;
  const persistence: AppStatePersistence | undefined = context.persistence;
  const flushReport: Promise<StateFlushReport> | undefined = context.persistence?.flush();
  const loaded: Promise<StateValue | undefined> | undefined = persistence?.load('tabs');
  const saved: Promise<void> | undefined = persistence?.save('tabs', ['a'], { storageKey: 'workspace' });
  const removed: Promise<void> | undefined = persistence?.remove('tabs');
  // @ts-expect-error Recovery and initialization belong to the App.
  persistence?.bind('tabs', [], { hydrate: true });
  // @ts-expect-error Only JSON may be saved.
  persistence?.save('tabs', new Date());
  // @ts-expect-error Storage options only allow the existing explicit key.
  persistence?.load('tabs', { hydrate: true });
  const limits: ProjectionLimits = context.projectionLimits;
  // @ts-expect-error The configured limits are read-only.
  limits.maxViews = 7;
  // @ts-expect-error Nested limits are read-only as well.
  limits.observation.maxCanonicalBytes = 8;
  // @ts-expect-error Retained memory limits are not author configuration.
  limits.maxTotalBytes;
  void context.prepareProjection(() => {});
  void context.prepareOpeningProjection(() => {}, () => {});
  // @ts-expect-error Regular preparation takes only the update.
  void context.prepareProjection(() => {}, { revert: () => {} });
  // @ts-expect-error Opening preparation requires a revert callback.
  void context.prepareOpeningProjection(() => {});
  // @ts-expect-error The update is synchronous.
  void context.prepareProjection(async () => {});
  // @ts-expect-error The opening update is synchronous.
  void context.prepareOpeningProjection(async () => {}, () => {});
  // @ts-expect-error The opening revert is synchronous.
  void context.prepareOpeningProjection(() => {}, async () => {});
  // @ts-expect-error Returned thenables are also asynchronous.
  void context.prepareProjection(() => ({} as PromiseLike<void>));
  // @ts-expect-error An opening update cannot return a thenable.
  void context.prepareOpeningProjection(() => ({} as PromiseLike<void>), () => {});
  // @ts-expect-error A revert callback cannot return a thenable.
  void context.prepareOpeningProjection(() => {}, () => ({} as PromiseLike<void>));
  // @ts-expect-error SDK Ref exporter is not part of the public context view.
  context.refExporter;
  // @ts-expect-error Lifecycle registration is exposed through useAppLifecycle.
  context.appLifecycle;
  void [appId, desktopId, launchConfig, persistence, flushReport, loaded, saved, removed];
}
void checkPublicContextShape;

type PublicTypes = [
  AppContext, AppID, ArrayRefHandle,
  DeepReadonly<unknown>, DesktopID, ArgsOf<typeof readRecord>,
  ItemRefFormatter,
  ListRefFormatter, ToolError, ToolResult,
  RefHandle, StatePersistenceOptions, StateFlushReport, StateIssue,
  StateValue,
  typeof defineViewType, typeof refParam, typeof StaticView, typeof DynamicView,
  ViewType,
  ViewProps<ViewType>,
];
declare const publicTypes: PublicTypes;
void publicTypes;

type NoRefHandleProperties = AssertNever<Extract<keyof RefHandle, 'data' | 'id'>>;
type ViewCloseHandler = AssertTrue<Equal<ViewProps<ViewType>['onClose'], (() => ToolResult | Promise<ToolResult>) | undefined>>;
type PublicShapeChecks = [NoRefHandleProperties, ViewCloseHandler];
void (null as unknown as PublicShapeChecks);

const config: TUIAppConfig = {
  app_name: 'public_api_types',
  viewTypes: [],
  component: () => null,
};
// @ts-expect-error Application metadata now uses whatItIs and whenToUse.
const oldDescriptionConfig: TUIAppConfig = { app_name: 'old_description', description: 'Old', component: () => null };
void oldDescriptionConfig;
const factory = createTUIApp(config);
const lifecycleProtocol: 'app-lifecycle-v2' = factory.appLifecycleSupport;
const authoringProtocol: 'view-type-tools-v7' = factory.toolAuthoringProtocol;
void lifecycleProtocol; void authoringProtocol;

const cleanup: AppLifecycleCallbacks = { stop() {}, close() {} };
useAppLifecycle(cleanup);
useAppLifecycle({});

const Reader = defineViewType<object>()({ multiplicity: 'multiple', name:'RecordDetail',tools:{
  read_record:{description:'Read a record.',execute:()=>({success:true}),inputSchema:Type.Object({status:Type.Enum(['ready','pending']),limit:Type.Optional(Type.Number())})},
}});
const readRecord = Reader.tools.read_record;

const RecordSource = Type.Object({ id: Type.String(), labels: Type.Array(Type.String()) });
const recordOptions = { scope: 'protected', refType: 'Record', schema: RecordSource } satisfies RefOptions;
const recordsOptions = { scope: 'protected', itemType: 'Record', schema: Type.Array(RecordSource) } satisfies ArrayRefOptions;
const record = { id: 'file (draft).txt', labels: ['Ready'] } as const;
const records = [record] as const;

function checkRefSourceTypes(unknownValue: unknown): void {
  const single = ref('current', record, recordOptions);
  const list = arrayRef('records', records, recordsOptions);
  formatRef('Current', single);
  formatRef('All', list);
  formatRef('First', list, 0);
  const label: RefHandle = useDataRef('current', record, recordOptions);
  const [all, first] = useArrayRef('records', records, recordsOptions);
  void [label('Current'), all('All'), first(0, 'First')];

  // @ts-expect-error Every published Ref requires a declared schema.
  ref('untyped', unknownValue, { scope: 'protected' });
  // @ts-expect-error Every published Ref requires a declared schema.
  useDataRef('untyped', unknownValue, { scope: 'protected', refType: 'Data', schema: undefined });
  // @ts-expect-error Every published Ref requires a declared schema.
  arrayRef('untyped_list', [unknownValue], { scope: 'protected', itemType: 'Data' });
  // @ts-expect-error Every published Ref requires a declared schema.
  useArrayRef('untyped_list', [unknownValue], { scope: 'protected' });

  // @ts-expect-error The value cannot widen a concrete TypeBox source schema.
  ref('wrong', { id: 3, labels: [] }, recordOptions);
  // @ts-expect-error Unknown values need narrowing before a typed publication.
  useDataRef('wrong', unknownValue, recordOptions);
  // @ts-expect-error The same source rules apply to nested fields in a Hook.
  useDataRef('wrong', { id: 'x', labels: [false] }, recordOptions);
  // @ts-expect-error Whole-array schema infers the type of its items.
  arrayRef('wrong', [{ id: 'x', labels: [false] }], recordsOptions);
  // @ts-expect-error An array of raw strings does not match the shared options.
  useArrayRef('wrong', ['one'], recordsOptions);
  // @ts-expect-error ArrayRef source schemas describe the whole array.
  arrayRef('wrong', records, { scope: 'protected', schema: RecordSource });
  // @ts-expect-error A scalar Ref has no array item formatter.
  formatRef('Wrong', single, 0);
  // @ts-expect-error Formatter input is the same descriptor provided for publication.
  formatRef('Wrong', 'current');
}
void checkRefSourceTypes;
