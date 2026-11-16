import Type from 'typebox';
import {
  createTUIApp,
  View,
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
  type AppReinitializeContext,
  type ArrayRefHandle,
  type DeepReadonly,
  type DesktopID,
  type ArgsOf,
  type ItemRefFormatter,
  type LLMUsageEvent,
  type ListRefFormatter,
  type ToolError,
  type ToolResult,
  type PersistMeta,
  type PersistOptions,
  type PersistStatus,
  type RefHandle,
  type StateBindingStatus,
  type StateFlushReport,
  type StateIssue,
  type StateValue,
  type TUIAppConfig,
  type ViewType,
  type ViewID,
  type ViewProps,
} from '../src/index.js';
import { arrayRef, formatRef, ref, type ArrayRefOptions, type RefOptions } from '../src/app.js';

// @ts-expect-error The retired handwritten parameter DSL no longer owns inference.
import type { InferArgs } from '../src/index.js';
// @ts-expect-error Parameter types are declared with the shared TypeBox schema.
import type { ParamBaseType } from '../src/index.js';
// @ts-expect-error The retired parameter-constraint DSL is not a public export.
import type { ParamConstraints } from '../src/index.js';
// @ts-expect-error The retired parameter-definition DSL is not a public export.
import type { ParamDef } from '../src/index.js';
// @ts-expect-error The retired parameter-schema DSL is not a public export.
import type { ParamSchema } from '../src/index.js';
// @ts-expect-error The retired parameter-type DSL is not a public export.
import type { ParamType } from '../src/index.js';

// The live channel takes only a listener.
// @ts-expect-error The retired options type is not part of the SDK root API.
import type { LLMOutputChannelOptions } from '../src/index.js';
import { useLLMUsage, usePersistentState } from '../src/index.js';
import './view-type-tool.js';

// @ts-expect-error Launch config is read from useAppRuntimeContext().
import { useAppEnv } from '../src/index.js';
// @ts-expect-error The SDK has no history source for this Hook.
import { useLLMOutputHistory } from '../src/index.js';
import type {
  ToolError as RuntimeToolError,
  ToolResult as RuntimeToolResult,
} from '@aotui/runtime/spi';

// These former exports describe retired/internal Runtime assembly surfaces.
// @ts-expect-error Legacy object-app interface is not part of the SDK root API.
import type { IAOTUIApp } from '../src/index.js';
// @ts-expect-error The Context object is private SDK plumbing.
import { ViewRuntimeContext } from '../src/index.js';
// @ts-expect-error The full SDK Context accessor is private.
import { useInternalAppRuntimeContext } from '../src/index.js';

void (null as unknown as IAOTUIApp);
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
  const captured = context.persistence?.captureValue({ tabs: ['a'] });
  const bound = context.persistence?.bind('tabs', [], { hydrate: true });
  void context.prepareProjection(() => {}, { revert: () => {} });
  // @ts-expect-error The opening update is synchronous.
  void context.prepareProjection(async () => {});
  // @ts-expect-error The opening revert is synchronous.
  void context.prepareProjection(() => {}, { revert: async () => {} });
  // @ts-expect-error Returned thenables are also asynchronous.
  void context.prepareProjection(() => ({} as PromiseLike<void>));
  // @ts-expect-error SDK Ref exporter is not part of the public context view.
  context.refExporter;
  // @ts-expect-error Lifecycle registration is exposed through useAppLifecycle.
  context.appLifecycle;
  void appId; void desktopId; void launchConfig; void persistence; void flushReport; void captured; void bound;
}
void checkPublicContextShape;

type PublicTypes = [
  AppContext, AppID, AppReinitializeContext, ArrayRefHandle,
  DeepReadonly<unknown>, DesktopID, ArgsOf<typeof readRecord>,
  ItemRefFormatter, LLMUsageEvent,
  ListRefFormatter, ToolError, ToolResult,
  PersistMeta, PersistOptions<string>, PersistStatus, RefHandle,
  StateBindingStatus, StateFlushReport, StateIssue,
  StateValue,
  typeof defineViewType, typeof refParam, typeof View,
  ViewType,
  ViewID, ViewProps,
];
declare const publicTypes: PublicTypes;
void publicTypes;

type NoRefHandleProperties = AssertNever<Extract<keyof RefHandle, 'data' | 'id'>>;
type NoViewCloseHandler = AssertNever<Extract<keyof ViewProps, 'onClose'>>;
type PublicShapeChecks = [NoRefHandleProperties, NoViewCloseHandler];
void (null as unknown as PublicShapeChecks);

useLLMUsage(() => {});
void useAppEnv;
void useLLMOutputHistory;
// @ts-expect-error The live channel accepts no configuration object.
useLLMUsage(() => {}, { includeHistory: false });
usePersistentState('public-api-type-check', 0, {
  storageKey: 'explicit-key',
  serialize: value => value,
  deserialize: value => Number(value),
  rehydrateOnReinitialize: true,
});
// @ts-expect-error Persistence does not support automatic debounce scheduling.
usePersistentState('public-api-type-check', 0, { debounceMs: 100 });

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
const authoringProtocol: 'view-type-tools-v5' = factory.toolAuthoringProtocol;
void lifecycleProtocol; void authoringProtocol;

const cleanup: AppLifecycleCallbacks = { stop() {}, close() {} };
useAppLifecycle(cleanup);
useAppLifecycle({});

const Reader = defineViewType<object>()({name:'RecordDetail',tools:{
  read_record:{description:'Read a record.',execute:()=>({success:true}),inputSchema:Type.Object({status:Type.Enum(['ready','pending']),limit:Type.Optional(Type.Number())})},
}});
const readRecord = Reader.tools.read_record;

const RecordSource = Type.Object({ id: Type.String(), labels: Type.Array(Type.String()) });
const recordOptions = { refType: 'Record', schema: RecordSource } satisfies RefOptions;
const recordsOptions = { itemType: 'Record', schema: Type.Array(RecordSource) } satisfies ArrayRefOptions;
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

  ref('untyped', unknownValue);
  useDataRef('untyped', unknownValue, { refType: 'Data', schema: undefined });
  arrayRef('untyped_list', [unknownValue], { itemType: 'Data' });
  useArrayRef('untyped_list', [unknownValue]);

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
  arrayRef('wrong', records, { schema: RecordSource });
  // @ts-expect-error A scalar Ref has no array item formatter.
  formatRef('Wrong', single, 0);
  // @ts-expect-error Formatter input is the same descriptor provided for publication.
  formatRef('Wrong', 'current');
}
void checkRefSourceTypes;
