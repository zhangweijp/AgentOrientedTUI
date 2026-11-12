import Type from 'typebox';
import {
  createTUIApp,
  AppTools,
  useAppLifecycle,
  useAppRuntimeContext,
  defineViewTypeTool,
  defineToolSet,
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
  type LLMOutputEvent,
  type LLMOutputListener,
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
  type ViewTypeToolDeclaration,
  type ToolBinding,
  type AppToolsProps,
  type ViewID,
  type ViewProps,
} from '../src/index.js';

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
import { useLLMOutputChannel, usePersistentState } from '../src/index.js';
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
  ItemRefFormatter, LLMOutputEvent,
  LLMOutputListener, ListRefFormatter, ToolError, ToolResult,
  PersistMeta, PersistOptions<string>, PersistStatus, RefHandle,
  StateBindingStatus, StateFlushReport, StateIssue,
  StateValue,
  typeof defineViewTypeTool, typeof refParam, typeof AppTools,
  ViewTypeToolDeclaration<ReturnType<typeof Type.Object>>, ToolBinding<typeof readRecord>, AppToolsProps<typeof readTools>,
  ViewID, ViewProps,
];
declare const publicTypes: PublicTypes;
void publicTypes;

type NoRefHandleProperties = AssertNever<Extract<keyof RefHandle, 'data' | 'id'>>;
type NoViewCloseHandler = AssertNever<Extract<keyof ViewProps, 'onClose'>>;
type PublicShapeChecks = [NoRefHandleProperties, NoViewCloseHandler];
void (null as unknown as PublicShapeChecks);

useLLMOutputChannel(() => {});
void useAppEnv;
void useLLMOutputHistory;
// @ts-expect-error The live channel accepts no configuration object.
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
const authoringProtocol: 'view-type-tools-v4' = factory.toolAuthoringProtocol;
void lifecycleProtocol; void authoringProtocol;

const cleanup: AppLifecycleCallbacks = { stop() {}, close() {} };
useAppLifecycle(cleanup);
useAppLifecycle({});

const readRecord = defineViewTypeTool({
  viewType: 'RecordDetail',
  name: 'read_record',
  description: 'Read a record.',
  inputSchema: Type.Object({
    status: Type.Enum(['ready', 'pending']),
    limit: Type.Optional(Type.Number()),
  }),
});
const readTools = defineToolSet({ readRecord });
AppTools({ definition: readTools, bindings: { readRecord: { execute(args) {
    const status: 'ready' | 'pending' = args.status;
    const limit: number | undefined = args.limit;
    void status;
    void limit;
    // Readonly ordinary arguments remain immutable, including the canonical
    // empty/ordinary-v2 Tool path.
    // @ts-expect-error Read-only Tool arguments are immutable.
    args.status = 'ready';
    return { success: true } satisfies ToolResult;
} } } });

const failedToolResult = {
  success: false,
  error: { code: 'PARTIAL_WRITE', message: 'The application reports partial work.' },
  effects: 'partial',
} satisfies ToolResult;
void failedToolResult;

const inspectSnapshot = defineViewTypeTool({ viewType: 'Record', name: 'inspect_snapshot',
  description: 'Inspect a displayed snapshot.', 
  inputSchema: Type.Object({ record: refParam('Record', Type.Object({ title: Type.String() })) }),
});
const snapshotTools = defineToolSet({ inspectSnapshot });
AppTools({ definition: snapshotTools, bindings: { inspectSnapshot: { execute(args) {
  const title: string = args.record.title;
  // @ts-expect-error Resolved Ref fields are recursively immutable.
  args.record.title = title;
  return { success: true };
} } } });
// @ts-expect-error The retired snapshot Hook has no public export.
import { useViewSnapshotTool } from '../src/index.js';

// A receipt cannot simultaneously claim success and failure; failure requires a JSON error record.
const shortReceipt: ToolResult = { success: true, data: { message: 'Done' } };
const knownFailure: ToolResult = { success: false, error: { code: 'BUSINESS_FAILED', message: 'No write', context: { phase: 'invocation' } }, effects: 'none' };
const uncertainFailure: ToolResult = { success: false, error: { code: 'BUSINESS_UNKNOWN', message: 'Observe before deciding next action' } };
// @ts-expect-error Success cannot carry an error.
const successAndError: ToolResult = { success: true, error: { code: 'BAD', message: 'bad' } };
// @ts-expect-error Success cannot declare failure effects.
const successAndEffects: ToolResult = { success: true, effects: 'none' };
// @ts-expect-error Failed results require a transport error record.
const missingError: ToolResult = { success: false };
// @ts-expect-error Error context must be JSON, not an exception.
const errorCause: ToolResult = { success: false, error: { code: 'BAD', message: 'bad', context: { cause: new Error('local only') } } };
// @ts-expect-error Receipts cannot carry functions as current business data.
const callbackData: ToolResult = { success: true, data: { callback() {} } };
void [shortReceipt, knownFailure, uncertainFailure, successAndError, successAndEffects, missingError, errorCause, callbackData];
