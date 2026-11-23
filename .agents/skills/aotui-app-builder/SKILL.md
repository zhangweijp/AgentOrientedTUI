---
name: aotui-app-builder
description: Use when designing or implementing an AOTUI application with @aotui/sdk, especially Root instructions, shared ViewType tools and page context, typed Ref/ArrayRef selection, and progressive disclosure.
---

# AOTUI App Builder

Build applications for Agent use. Views present current state. Tools return concise receipts. Start with the [SDK README](../../../sdk/README.md) and run its counter through the [Runtime README](../../../runtime/README.md).

Preact Apps use `preact@10.29.1` and share one installed Preact instance with the SDK. Keep `preact` and its subpaths external when bundling. Plain TypeScript Apps can use `@aotui/sdk/app` independently.

## Declare the type and provide page context

Use `defineViewType<Context>()({ name, multiplicity, tools })` to declare each tool's description, optional business Schema, and `execute({ input, context })` in one place. Use `defineViewType({ name, multiplicity })` for a type without tools. Choose `single` for one page per App or `multiple` for concurrently open pages of the same type. List the descriptors in the App factory's `viewTypes`.

Each page with tools supplies its own `context`. It can contain page state, setters, or App services. In Preact mount the declared type as JSX or pass it to `StaticView` or `DynamicView`. Supply the page context on that element. In plain TypeScript, keep a stable `createView(type, { region, render })` handle and return body, refs, and context from `render`. Call `prepareProjection({ views })` with all open handles. Use the optional synchronous `enabled(context)` to decide availability for each page. Multi-instance tool calls require the receiving page's XML `view_id`. Single-instance tool calls omit that field. The handler receives business fields and the selected page context.

Use Root to explain the App's workflow. The model request carries available operations and their schemas. See the repository's executable [plain TypeScript App](../../../sdk/tests/fixtures/work-items-plain.ts) and [Preact App](../../../sdk/tests/fixtures/work-items-preact.tsx).

## App metadata and result records

Keep author metadata in `createApp` or `createTUIApp` once. Build with the SDK and its author peers, then run the SDK's `generate-aoapp <app-dir>` command to derive the manifest from the built factory and package metadata. Registry reads the static manifest. The Desktop opens an installation by `installation_id`. Runtime returns the running `app_id` and binds interactions to the actual instance.

ToolResult is discriminated by success. A successful short receipt has success:true and optional JSON object data, without error/effects. A failure requires a plain JSON error record containing code and message, with optional JSON context and short recovery data. Record known recovery details in the receipt. Do not return Error instances, stack/cause, functions or undefined. An unknown outcome is not permission to replay a business command. The current View remains the source of business data, separate from the receipt.

For the standard native Tool adapter choose ASCII letters, digits and underscores for Tool/ViewType names. The adapter normally publishes `app_id-toolName` and qualifies it with the ViewType when an App declares the same tool name in multiple types or the short alias is reserved by Desktop. Keep the resulting alias within 64 characters. The current Tools array supplies callable names.

## Select published objects through Ref

For a business object already published as a Ref, show a meaningful description and its typed local Ref marker. The model passes `$app_id.view_id.local_ref`. Copy the first two parts from the publishing page XML. App handlers can use business IDs carried inside the published data. Runtime resolves against the invocation's adopted Observation; the handler receives recursively readonly business values. IDs can remain inside App state and Ref payloads.

Publish a Ref together with its scope. Use `private` for the owning page, `protected` for pages in the same App instance, or `public` to also allow Tools in other Apps presented in the same model request to select the value. In plain TypeScript use `ref('current', value, { scope: 'protected', refType: 'Note', schema: Note })` or `arrayRef('notes', values, { scope: 'protected', itemType: 'Note', schema: Type.Array(Note) })`. In Preact use the same options with `useDataRef` and `useArrayRef`. Declare an array once and use its element markers to label individual selections.

The whole-collection marker can read `[Notes](protected notes: Note[])` and an element marker can read `[Draft](notes[0])`. In App `journal`, View `notes_view`, the element address is `$journal.notes_view.notes[0]`. Use a JSON-quoted member such as `$journal.notes_view["file.name"]` for a literal local name containing a dot. Ordinary named business fields accept a literal or a full Ref address. Use `$$` to supply a literal leading dollar. Use `refParam` only where the app requires a published source.

For an ordinary string parameter, the Agent can select a granted field such as `$journal.notes_view.notes[0].title`. Object keys use dot notation or JSON-quoted brackets, and array indices use numbers. A `refParam` parameter requires a whole published Ref or a declared ArrayRef element with its nominal label. Host policy can limit paths to specific receiving mounts.

```ts
import Type from 'typebox';
import { defineViewType, refParam } from '@aotui/sdk/app';

const Note = Type.Object({ id: Type.String(), title: Type.String() });
type Note = Type.Static<typeof Note>;
type NotesContext = { inspect(selected: readonly Note[], whole?: readonly Note[], message?: string): void };
export const Notes = defineViewType<NotesContext>()({ name: 'Notes', multiplicity: 'single', region: 'dynamic', tools: {
  inspect: {
    description: 'Inspect selected Notes; read Notes View.',
    inputSchema: Type.Object({
      selected: Type.Array(refParam('Note', Note), { maxItems: 50 }),
      whole: Type.Optional(refParam('Note', Type.Array(Note))),
      message: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute({ input, context }) {
      context.inspect(input.selected, input.whole, input.message);
      return { success: true };
    },
  },
} });
// App journal and View notes_view. Model input:
// { selected: ['$journal.notes_view.notes[1]', '$journal.notes_view.notes[0]'], whole: '$journal.notes_view.notes' }
// selected is an ordered readonly array of Note objects.
// whole is the original readonly list when supplied.
```

- `refParam(type, ObjectSchema)` selects one object, including a natural ArrayRef element.
- `refParam(type, Type.Array(ObjectSchema))` selects one complete list Ref; its model input is one string.
- `Type.Array(refParam(...))` selects several complete Ref names; its model input is an array of strings. Order and duplicates remain; [] is a provided empty selection.
- `Type.Optional(...)` leaves omitted fields absent. An explicit Ref input must be a valid address string even when the selected JSON value is null.

Multiple, optional and selection fields compose at the Tool parameter root. A Ref may select any supported JSON value, including a scalar, null, a nested object, or an array. The target schema validates the selected value after dereferencing. The complete invocation shares one parameter budget. [Schema compiler](../../../core/src/tool/tool-parameters.ts)

The App still checks that resolved objects exist, belong to the intended current business context, and are permitted. Ref does not replace those checks or freeze the App's live data. Meaningful paths, titles, edit contents and amounts can remain ordinary fields. Readonly argument values do not constrain App business effects; authorization and current-state checks remain independent.

## Views and instructions

A View is an independent Agent work page. Choose `static` for stable guidance and `dynamic` for changing work. A single ViewType can override its ID with `id`. A multiple ViewType can set `idPrefix` or supply `createId` in its declaration. Keep mounts and plain TypeScript View handles stable as data changes. In plain TypeScript provide a Markdown `body`. In Preact use sibling pages with semantic text content.

Submit the raw Markdown body. The Runtime message boundary encodes XML text once, including CR/CRLF, and Host preview decodes it once. Use pre/code for exact file, patch and log text. [View props](../../../sdk/src/components/View.tsx)

Keep Root instructions in English unless the application requires another language. Explain:

- What the application does and the normal workflow.
- Which ViewTypes are currently relevant and which Tools apply to each.
- The containing View id and local Ref names used to select existing objects and how to recover after an invalid choice.
- Where to inspect the resulting current state after a receipt.

Keep the Schema, handler, rendered references and recovery guidance in agreement. Do not hide IDs in text while still requiring them as model inputs. Keep business data in View instead of duplicating its current contents in a receipt.

## Submission, observation and checks

Use `prepareProjection` for the current App state, including after a business write or a View close. Plain TypeScript supplies every open View handle. Preact supplies a synchronous state update and awaits the real render commit. An invalid ordinary frame retains prior identities for diagnosis and pauses new dispatch until a valid frame is accepted. Preserve a successful write receipt if projection preparation fails. Repair the projection from current App state.

Use `prepareOpeningProjection({ views })` in plain TypeScript or `prepareOpeningProjection(update, revert)` through Preact's `useAppRuntimeContext()` for reversible navigation. Plain TypeScript confirms navigation state after the complete candidate is prepared. Preact requires two synchronous callbacks and checks restoration on `OBSERVATION_CAPACITY`. The current Views and their operations remain valid after capacity rejection when navigation is successfully abandoned or restored. `PreparedProjection` describes the local source. The next successful Host observation establishes current View visibility.

Read the fixed `projectionLimits` from the plain TypeScript author context or `useAppRuntimeContext()` when choosing initial content or an App page size. The frozen values describe the full installed App projection. Use preparation results for actual capacity decisions. The Host budgets the assembled model input and output separately.

Trusted Host consumers prepare an Observation, explicitly adopt it, then invoke with its Observation ID, Tool ID and input matching the observed native Schema. Adoption of a new Observation revokes the previous calling eligibility; publication and diagnostic preview alone do not adopt. The Runtime owns observing, invoking, and resolving Refs for each App instance.

Verify first/last matching View activation, disabled/re-enabled Tools, correct and invalid Ref selections, optional absence, ordering and duplicates, business membership checks, updated View state and final resource release. Test through the matching actual SDK/Runtime packages; visibility or matching version strings alone do not prove compatibility.

Set `persistence: true` in `createApp` or `createTUIApp` when using the SDK state service. Keep only deliberately chosen JSON state there. Before returning a Tool receipt that promises a save, await `persistence.flush()` and check its result.

The [Notes test App](../../../sdk/tests/fixtures/ref-app.tsx) exercises object, whole-list, element and ordered multiple selections, including optional fields.
