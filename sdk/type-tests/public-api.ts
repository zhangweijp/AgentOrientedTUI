import Type from 'typebox';
import {
    arrayRef, createApp, createView, defineViewType, formatRef, ref,
    type AppAuthorContext, type AppID, type AppLifecycleCallbacks, type ArrayRefOptions,
    type CreateAppConfig, type DesktopID, type PublishResult, type ProjectionLimits,
    type RefOptions, type ToolError, type ToolResult, type TUIAppFactory, type ViewHandle,
} from '@aotui/sdk';
import type { ToolError as RuntimeToolError, ToolResult as RuntimeToolResult } from '@aotui/core';

type Equal<L, R> = (<T>() => T extends L ? 1 : 2) extends (<T>() => T extends R ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type PublicChecks = [
    Assert<Equal<ToolError, RuntimeToolError>>,
    Assert<Equal<ToolResult, RuntimeToolResult>>,
    Assert<Equal<ReturnType<AppAuthorContext['readViewId']>, string | undefined>>,
];
void (null as unknown as PublicChecks);

const Note = defineViewType({ name: 'Note', region: 'dynamic', multiplicity: 'single' });
const cleanup: AppLifecycleCallbacks = { stop() {}, async close() {} };
const config: CreateAppConfig = {
    app_name: 'public_api_types', viewTypes: [Note],
    initialize(context) {
        const app: AppID = context.appId;
        const desktop: DesktopID = context.desktopId;
        const limits: ProjectionLimits = context.projectionLimits;
        const note = createView(Note);
        const result: PublishResult = context.publish(() => [note.frame({body: "Note"})]);
        const opening: PublishResult = context.publish(() => [note.frame({body: "Note"})], {mode: "candidate"});
        if (!opening.ok) void opening.issue.code;
        const registered: void = context.registerLifecycle(cleanup);
        void registered;
        // @ts-expect-error No author-controlled lifecycle starter or legacy cleanup entry.
        context.registerCleanup(cleanup);
        context.readViewId(note);
        // @ts-expect-error Preparation takes a complete frame.
        context.publish(() => [note]);
        // @ts-expect-error The author handle is required for a routing ID.
        context.readViewId('Note', 'page title');
        // @ts-expect-error The author's limits are read-only.
        limits.observation.maxCanonicalBytes = 8;
        // @ts-expect-error Producer operations belong to the Runtime.
        context.publishFrame;
        // @ts-expect-error Closed-frame health belongs to the Runtime.
        context.appLifecycle;
        void [app, desktop, result];
    },
};
export const factory: TUIAppFactory = createApp(config);
const lifecycleProtocol: 'app-lifecycle-v3' = factory.appLifecycleSupport;
const authoringProtocol: 'view-type-tools-v9' = factory.toolAuthoringProtocol;
void [lifecycleProtocol, authoringProtocol];

const RecordSchema = Type.Object({ id: Type.String(), labels: Type.Array(Type.String()) });
const recordOptions = { scope: 'protected', refType: 'Record', schema: RecordSchema } satisfies RefOptions;
const recordsOptions = { scope: 'protected', itemType: 'Record', schema: Type.Array(RecordSchema) } satisfies ArrayRefOptions;
const record = { id: 'file (draft).txt', labels: ['Ready'] } as const;
const records = [record] as const;

export function checkRefSourceTypes(unknownValue: unknown): void {
    const single = ref('current', record, recordOptions);
    const list = arrayRef('records', records, recordsOptions);
    formatRef('Current', single);
    formatRef('All', list);
    formatRef('First', list, 0);
    // @ts-expect-error Every published Ref requires a declared schema.
    ref('untyped', unknownValue, { scope: 'protected' });
    // @ts-expect-error Every published ArrayRef requires a declared schema.
    arrayRef('untyped_list', [unknownValue], { scope: 'protected', itemType: 'Data' });
    // @ts-expect-error The value must match the concrete source schema.
    ref('wrong', { id: 3, labels: [] }, recordOptions);
    // @ts-expect-error The whole-array schema infers the type of its items.
    arrayRef('wrong', [{ id: 'x', labels: [false] }], recordsOptions);
    // @ts-expect-error The Schema for an ArrayRef describes the whole array.
    arrayRef('wrong', records, { scope: 'protected', schema: RecordSchema });
    // @ts-expect-error An element marker requires an ArrayRef.
    formatRef('Wrong', single, 0);
    // @ts-expect-error The formatter expects the descriptor.
    formatRef('Wrong', 'current');
}
