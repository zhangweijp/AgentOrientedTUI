---
name: aotui-app-builder
description: Use when designing or implementing an AOTUI application with @aotui/sdk, especially Root instructions, shared ViewType tools and page context, typed Ref/ArrayRef selection, and progressive disclosure.
---

# AOTUI App Builder

Build applications for Agent use. Views present current state. Tools return concise receipts. Start with the [SDK README](../../../sdk/README.md) and run its counter through the [Runtime README](../../../runtime/README.md).

Preact Apps use `preact@10.29.1` and share one installed Preact instance with the SDK. Keep `preact` and its subpaths external when bundling. Plain TypeScript Apps can use `@aotui/sdk/app` independently.

## Declare the type and provide page context

Use `defineViewType<Context>()({ name, tools })` to declare each tool's description, optional business Schema, and `execute({ input, context })` in one place. Use `defineViewType({ name })` for a type without tools. List the descriptors in the App factory's `viewTypes`.

Each page with tools supplies its own `context`. It can contain page state, setters, or App services. Preact passes it to `View.context`. In plain TypeScript, keep a stable `createView(type, { id, kind, render })` handle and return body, refs, and context from `render`. Call `prepareProjection({ views })` with all open handles. Use the optional synchronous `enabled(context)` to decide availability for each page. Native Tool calls require the receiving page's XML `view_id`. The handler's `input` contains the business fields.

Use `<ToolCatalog />` in Root for the registered tool names. The model request carries available operations and their schemas. See the repository's executable [plain TypeScript App](../../../sdk/tests/fixtures/work-items-plain.ts) and [Preact App](../../../sdk/tests/fixtures/work-items-preact.tsx).

## App metadata and result records

Keep author metadata in `createApp` or `createTUIApp` once. Build the factory, then use the repository's `generate-aoapp` script to derive the manifest from the built factory and package metadata. Registry reads the static manifest. Its canonical key must match `app_name`. Runtime owns the separate App and instance identities.

ToolResult is discriminated by success. A successful short receipt has success:true and optional JSON object data, without error/effects. A failure requires a plain JSON error record containing code and message, with optional JSON context and short recovery data. Record known recovery details in the receipt. Do not return Error instances, stack/cause, functions or undefined. An unknown outcome is not permission to replay a business command. The current View remains the source of business data, separate from the receipt.

For the standard native Tool adapter choose ASCII letters, digits and underscores for Tool/ViewType names. The adapter normally publishes `appName-toolName` and qualifies it with the ViewType when an App declares the same tool name in multiple types or the short alias is reserved by Desktop. Keep the resulting alias within 64 characters. The current Tools array supplies callable names.

## Select published objects through Ref

For a business object already published as a Ref, show a meaningful description and its typed local Ref marker. The model passes view_id.local_ref without the display type prefix instead of copying internal plan_id, phase_id, task_id or uploading a payload. Runtime resolves against the invocation's adopted Observation; the handler receives recursively readonly business values. IDs can remain inside App state and Ref payloads.

In plain TypeScript, put `ref('current', value, { refType: 'Note', schema: Note })` or `arrayRef('notes', values, { itemType: 'Note', schema: Type.Array(Note) })` in the View's `refs`. Render the same descriptor with `formatRef(label, descriptor)` or select an array item with `formatRef(label, descriptor, index)`. In Preact, use the same options with `useDataRef` or `useArrayRef` and call the returned formatters. A source schema infers the value type and checks the captured JSON. For an array it describes the full array, including constraints on length. A Tool can declare a stricter target schema. Display names include `Note:current`, `Note[]:notes`, and `Note:notes[0]`. The model passes addresses such as `notes_view.notes[0]`. Use literal local IDs and follow the [Ref marker checks](../../../sdk/src/app-factory/refs.ts).

```ts
import Type from 'typebox';
import { defineViewType, refParam } from '@aotui/sdk/app';

const Note = Type.Object({ id: Type.String(), title: Type.String() });
type Note = Type.Static<typeof Note>;
type NotesContext = { inspect(selected: readonly Note[], whole?: readonly Note[], message?: string): void };
export const Notes = defineViewType<NotesContext>()({ name: 'Notes', tools: {
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
// In View id=notes_view; model: { view_id: 'notes_view', selected: ['notes_view.notes[1]', 'notes_view.notes[0]'], whole: 'notes_view.notes' }
// selected is an ordered readonly array of Note objects.
// whole is the original readonly list when supplied.
```

- `refParam(type, ObjectSchema)` selects one object, including a natural ArrayRef element.
- `refParam(type, Type.Array(ObjectSchema))` selects one complete list Ref; its model input is one string.
- `Type.Array(refParam(...))` selects several complete Ref names; its model input is an array of strings. Order and duplicates remain; [] is a provided empty selection.
- `Type.Optional(...)` leaves omitted fields absent. An explicit Ref input must be a valid address string even when the selected JSON value is null.

Multiple, optional and selection fields compose at the Tool parameter root. A Ref may select any supported JSON value, including a scalar, null, a nested object, or an array. The target schema validates the selected value after dereferencing. The complete invocation shares one parameter budget. See the [schema compiler](../../../runtime/src/core/tool/ordinary-parameter-contract.ts).

The App still checks that resolved objects exist, belong to the intended current business context, and are permitted. Ref does not replace those checks or freeze the App's live data. Meaningful paths, titles, edit contents and amounts can remain ordinary fields. Readonly argument values do not constrain App business effects; authorization and current-state checks remain independent.

## Views and instructions

A View is an independent Agent work page. Declare `id`, `type`, and `kind` (`instruction` or `state`) explicitly. In plain TypeScript provide a Markdown `body`. In Preact use sibling `View` components for distinct pages and semantic text tags within a page.

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

Trusted Host consumers prepare an Observation, explicitly adopt it, then invoke with its Observation ID, Tool ID, and receiving View ID. Adoption of a new Observation revokes the previous calling eligibility; publication and diagnostic preview alone do not adopt. The Runtime owns observing, invoking, and resolving Refs for each App instance.

Verify first/last matching View activation, disabled/re-enabled Tools, correct and invalid Ref selections, optional absence, ordering and duplicates, business membership checks, updated View state and final resource release. Test through the matching actual SDK/Runtime packages; visibility or matching version strings alone do not prove compatibility.

Set `persistence: true` in `createApp` or `createTUIApp` when using the SDK state service. Keep only deliberately chosen JSON state there. Before returning a Tool receipt that promises a save, await `persistence.flush()` and check its result.

The [Notes test App](../../../sdk/tests/fixtures/ref-app.tsx) exercises object, whole-list, element and ordered multiple selections, including optional fields.
