import {
  createTUIApp,
  useAppLifecycle,
  useAppRuntimeContext,
  useViewTypeTool,
  type AppLifecycleCallbacks,
  type AppContext,
  type AppStatePersistence,
  type AppID,
  type AppReinitializeContext,
  type ArrayRefHandle,
  type DeepReadonly,
  type DesktopID,
  type InferArgs,
  type IViewMeta,
  type ItemRefFormatter,
  type LLMOutputEvent,
  type LLMOutputListener,
  type ListRefFormatter,
  type OperationError,
  type OperationResult,
  type ParamBaseType,
  type ParamConstraints,
  type ParamDef,
  type ParamSchema,
  type ParamType,
  type PersistMeta,
  type PersistOptions,
  type PersistStatus,
  type RefHandle,
  type SnapshotValueRefParamDef,
  type StateBindingStatus,
  type StateFlushReport,
  type StateIssue,
  type StateValue,
  type TUIAppConfig,
  type TypeToolArgs,
  type TypeToolHandler,
  type TypeToolOptions,
  type TypeToolUI,
  type UseViewTypeToolResult,
  type ViewID,
  type ViewProps,
} from '../src/index.js';

// The live channel takes only a listener; history is a separate Provider API.
// @ts-expect-error The retired options type is not part of the SDK root API.
import type { LLMOutputChannelOptions } from '../src/index.js';
import { useLLMOutputChannel, usePersistentState } from '../src/index.js';

// These former exports describe retired/internal Runtime assembly surfaces.
// @ts-expect-error Legacy object-app interface is not part of the SDK root API.
import type { IAOTUIApp } from '../src/index.js';
// @ts-expect-error Provider assembly context is Runtime plumbing, not SDK authoring API.
import type { ILLMOutputChannelContext } from '../src/index.js';
// @ts-expect-error The Context object is private SDK plumbing.
import { ViewRuntimeContext } from '../src/index.js';
// @ts-expect-error The full SDK Context accessor is private.
import { useInternalAppRuntimeContext } from '../src/index.js';

void (null as unknown as IAOTUIApp);
void (null as unknown as ILLMOutputChannelContext);
void ViewRuntimeContext;
void useInternalAppRuntimeContext;
type PublicAppRuntimeContext = ReturnType<typeof useAppRuntimeContext>;
type InternalContextKeys = Extract<keyof PublicAppRuntimeContext,
  'refExporter' | 'markDirty' | 'projection' | 'viewTools' | 'appLifecycle'>;
type AssertNever<Value extends never> = Value;
type AssertTrue<Value extends true> = Value;
type NoInternalContextPorts = AssertNever<InternalContextKeys>;
type PublicPersistence = NonNullable<PublicAppRuntimeContext['persistence']>;
type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
const publicPersistenceIsTheManagedPort: AssertTrue<Equal<PublicPersistence, AppStatePersistence>> = true;
type PublicContextChecks = [NoInternalContextPorts, typeof publicPersistenceIsTheManagedPort];
function checkPublicContextShape() {
  const context = useAppRuntimeContext();
  const appId: AppID = context.appId;
  const desktopId: DesktopID = context.desktopId;
  const launchConfig: Record<string, unknown> | undefined = context.launchConfig;
  const persistence: AppStatePersistence | undefined = context.persistence;
  const flushReport: Promise<StateFlushReport> | undefined = context.persistence?.flush();
  const captured = context.persistence?.captureValue({ tabs: ['a'] });
  const bound = context.persistence?.bind('tabs', [], { hydrate: true });
  // @ts-expect-error SDK Ref exporter is not part of the public context view.
  context.refExporter;
  // @ts-expect-error Lifecycle registration is exposed through useAppLifecycle.
  context.appLifecycle;
  void appId; void desktopId; void launchConfig; void persistence; void flushReport; void captured; void bound;
}
void checkPublicContextShape;

type PublicTypes = [
  AppContext, AppID, AppReinitializeContext, ArrayRefHandle,
  DeepReadonly<unknown>, DesktopID, InferArgs<{ value: { type: 'string' } }>,
  IViewMeta, ItemRefFormatter, LLMOutputEvent,
  LLMOutputListener, ListRefFormatter, OperationError, OperationResult,
  ParamBaseType, ParamConstraints, ParamDef, ParamSchema, ParamType,
  PersistMeta, PersistOptions<string>, PersistStatus, RefHandle,
  SnapshotValueRefParamDef, StateBindingStatus, StateFlushReport, StateIssue,
  StateValue,
  TypeToolArgs<{ value: { type: 'string' } }, { isMutating: false }>,
  TypeToolHandler, TypeToolOptions, TypeToolUI, UseViewTypeToolResult,
  ViewID, ViewProps,
];
declare const publicTypes: PublicTypes;
void publicTypes;

type NoRefHandleProperties = AssertNever<Extract<keyof RefHandle, 'data' | 'id'>>;
type NoViewCloseHandler = AssertNever<Extract<keyof ViewProps, 'onClose'>>;
type NoPublicMountIdentity = AssertNever<Extract<keyof IViewMeta, 'viewGeneration' | 'viewInstanceId'>>;
type PublicShapeChecks = [NoRefHandleProperties, NoViewCloseHandler, NoPublicMountIdentity];
void (null as unknown as PublicShapeChecks);

useLLMOutputChannel(() => {});
// @ts-expect-error Live channel history policy belongs to its actual Provider.
useLLMOutputChannel(() => {}, { includeHistory: false });
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
  component: () => null,
};
// @ts-expect-error Application metadata now uses whatItIs and whenToUse.
const oldDescriptionConfig: TUIAppConfig = { app_name: 'old_description', description: 'Old', component: () => null };
void oldDescriptionConfig;
const factory = createTUIApp(config);
const lifecycleProtocol: 'app-lifecycle-v2' = factory.appLifecycleSupport;
void lifecycleProtocol;

const cleanup: AppLifecycleCallbacks = { stop() {}, close() {} };
useAppLifecycle(cleanup);
useAppLifecycle({});

useViewTypeTool(
  'read_record',
  {
    description: 'Read a record.',
    isMutating: false,
    params: {
      status: { type: 'enum', options: ['ready', 'pending'], required: true },
      limit: { type: 'number' },
    },
  },
  args => {
    const status: 'ready' | 'pending' = args.status;
    const limit: number | undefined = args.limit;
    void status;
    void limit;
    // Readonly ordinary arguments remain immutable, including the canonical
    // empty/ordinary-v2 Tool path.
    // @ts-expect-error Read-only Tool arguments are immutable.
    args.status = 'ready';
    return { success: true } satisfies OperationResult;
  },
);

useViewTypeTool(
  'inspect_snapshot',
  {
    description: 'Inspect a displayed snapshot.',
    isMutating: false,
    params: {
      record: { type: 'reference', required: true, refSource: 'snapshot-value-v1' },
    },
  },
  args => {
    // The Ref payload remains unknown unless the app provides its own checked
    // business type, while the declared parameter is still required.
    const record: unknown = args.record;
    void record;
    return { success: true };
  },
);
