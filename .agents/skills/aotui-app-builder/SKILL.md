---
name: aotui-app-builder
description: Use when designing or implementing an AOTUI application with @aotui/sdk, especially Root instructions, shared ViewType tools and page context, typed Ref/ArrayRef selection, and progressive disclosure.
---

# AOTUI App Builder

Build applications for Agent use. Views present current state. Tools return concise receipts. Build the note App in the [SDK README](../../../sdk/README.md) and run it with the Host example in the [Runtime README](../../../runtime/README.md).

Import `createApp`, `createView`, and `defineViewType` from the TypeScript SDK root `@aotui/sdk`. Declare rules as plain JSON Schema, use Standard JSON Schema v1 that exports draft-2020-12, or add TypeBox as an author dependency. All three use the supported AOTUI Schema subset.

## Declare the type and provide page context

Use `defineViewType<Context>()({ name, multiplicity, tools })` to declare each tool's description, optional business Schema, and `execute({ input, context })` in one place. Use `defineViewType({ name, multiplicity })` for a type without tools. Choose `single` for one page per App or `multiple` for concurrently open pages of the same type. List the descriptors in the App factory's `viewTypes`.

Each page with tools supplies its own `context`. It can contain page state, setters, or App services. Keep a stable `createView(type, { region, render })` handle and return body, refs, and context from `render`. Call `prepareProjection({ views })` with all open handles. Use the optional synchronous `enabled(context)` to decide availability for each page. Multi-instance tool calls require the receiving page's XML `view_id`. Single-instance tool calls omit that field. The handler receives business fields and the selected page context.

Use Root to explain the App's workflow. The model request carries available operations and their schemas. [Runnable Work Items App](../../../sdk/tests/fixtures/work-items-plain.ts)

## App metadata and result records

Pass `app_name` to `createApp` and set the same value in `package.json` at `aotui.app_name`. Put optional `whatItIs` and `whenToUse` in the `aotui` object. `version`, `description`, `main`, and `types` are top-level package fields. After building, run the SDK's `generate-aoapp <app-dir>` command to write the static manifest. Runtime checks the loaded factory against that manifest. The Desktop opens an installation by `installation_id`. Runtime returns the running `app_id` and binds interactions to the actual instance.

ToolResult is discriminated by success. A successful short receipt has success:true and optional JSON object data, without error/effects. A failure requires a plain JSON error record containing code and message, with optional JSON context and short recovery data. Record known recovery details in the receipt. Do not return Error instances, stack/cause, functions or undefined. An unknown outcome is not permission to replay a business command. The current View remains the source of business data, separate from the receipt.

For the standard native Tool adapter choose ASCII letters, digits and underscores for Tool/ViewType names. The adapter normally publishes `app_id-toolName` and qualifies it with the ViewType when the same tool name appears on multiple observed ViewTypes or the short alias is reserved by Desktop. Keep the resulting alias within 64 characters. The current Tools array supplies callable names.

## Select published objects through Ref

For a business object already published as a Ref, show a meaningful description and its typed local Ref marker. The model passes `$ref.app_id.view_id.local_ref`. Copy the first two parts from the publishing page XML. App handlers can use business IDs carried inside the published data. Runtime resolves against the invocation's adopted Observation; the handler receives recursively readonly business values. IDs can remain inside App state and Ref payloads.

Publish every Ref with its scope and value schema. Use `private` for the owning page, `protected` for pages in the same App instance, or `public` to also allow Tools in other Apps presented in the same model request to select the value. Use `ref('current', value, { scope: 'protected', refType: 'Note', schema: Note })` or `arrayRef('notes', values, { scope: 'protected', itemType: 'Note', schema: Type.Array(Note) })`. Declare an array once and use its element markers to label individual selections.

The whole-collection marker can read `[Notes](protected notes: Note[])` and an element marker can read `[Draft](notes[0])`. In App `journal`, View `notes_view`, the element address is `$ref.journal.notes_view.notes[0]`. Ref IDs use an identifier. For an object key containing a dot, use a JSON-quoted member after the Ref ID, such as `$ref.journal.notes_view.current["file.name"]`. Ordinary named business fields accept a literal or a full Ref address. Add one leading `$` when a literal argument or direct array element starts with one or more dollar signs followed by `ref.`. Send literal `$ref.x` as `$$ref.x` and literal `$$ref.x` as `$$$ref.x`. Other leading dollar signs, nested JSON, and text containing `$ref.` in the middle are ordinary data. Use `refParam` only where the app requires a published source.

For an ordinary string parameter, the Agent can select a granted field such as `$ref.journal.notes_view.notes[0].title`. Object keys use dot notation or JSON-quoted brackets, and array indices use numbers. A `refParam` parameter requires a whole published Ref or a declared ArrayRef element with its nominal label. Host policy can restrict each visible Ref to particular receiving mounts. The Agent can inspect the declared schema of any visible Ref and directly read a visible public value through `system-inspect_ref`.

```ts
import Type from 'typebox';
import { defineViewType, refParam } from '@aotui/sdk';

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
// { selected: ['$ref.journal.notes_view.notes[1]', '$ref.journal.notes_view.notes[0]'], whole: '$ref.journal.notes_view.notes' }
// selected is an ordered readonly array of Note objects.
// whole is the original readonly list when supplied.
```

- `refParam(type, ObjectSchema)` selects one object, including a natural ArrayRef element.
- `refParam(type, Type.Array(ObjectSchema))` selects one complete list Ref; its model input is one string.
- `Type.Array(refParam(...))` selects several complete Ref names; its model input is an array of strings. Order and duplicates remain; [] is a provided empty selection.
- `Type.Optional(...)` leaves omitted fields absent. An explicit Ref input must be a valid address string even when the selected JSON value is null.

Multiple, optional and selection fields compose at the Tool parameter root. A Ref may select any supported JSON value, including a scalar, null, a nested object, or an array. The target schema validates the selected value after dereferencing. The complete invocation shares one parameter budget. [Schema compiler](../../../core/src/tool/tool-parameters.ts)

Use an object for the Tool's `inputSchema`. A member declared as `Type.Unknown()` or `{}` accepts bounded JSON, including when placed in array items or nested fields. A declared Ref value and the value schema passed to `refParam` need a root shape such as `{ type: 'object' }`. Provider tool policies separately check whether the selected encoder and mode can transmit the schema.

The App still checks that resolved objects exist, belong to the intended current business context, and are permitted. Ref does not replace those checks or freeze the App's live data. Meaningful paths, titles, edit contents and amounts can remain ordinary fields. Readonly argument values do not constrain App business effects; authorization and current-state checks remain independent.

## Views and instructions

A View is an independent Agent work page. Choose `static` for stable guidance and `dynamic` for changing work. Use ASCII letters, digits and underscores in `view_type`, with at least one letter. A single ViewType can override its ID with `id`. For a multiple ViewType, the framework assigns `<prefix>_<n>` using the type name or the supplied `idPrefix`. Keep View handles stable as data changes. Return a Markdown `body` from the page’s render function.

When an open receipt needs a routing ID, call `readViewId(handle)` after successful `prepareOpeningProjection`. The SDK reads the ID of that exact handle from the latest healthy frame.

Submit the raw Markdown body. The Runtime message boundary encodes XML text once, including CR/CRLF, and Host preview decodes it once. Use Markdown code fences for exact file, patch and log text. [SDK View API](../../../sdk/README.md)

Keep Root instructions in English unless the application requires another language. Explain:

- What the application does and the normal workflow.
- Which ViewTypes are currently relevant and which Tools apply to each.
- The containing View id and local Ref names used to select existing objects and how to recover after an invalid choice.
- Where to inspect the resulting current state after a receipt.

Keep the Schema, handler, rendered references and recovery guidance in agreement. Do not hide IDs in text while still requiring them as model inputs. Keep business data in View instead of duplicating its current contents in a receipt.

## Submission, observation and checks

Use `prepareProjection` for the current App state, including after a business write or a View close. Supply every open View handle. An invalid ordinary frame retains prior identities for diagnosis and pauses new dispatch until a valid frame is accepted. Preserve a successful write receipt if projection preparation fails. Repair the projection from current App state.

Use `prepareOpeningProjection({ views })` for a tentative open. Update the App's own navigation only after the candidate is accepted. On a capacity rejection, retain the previous projection and tell the Agent which page it can close to make space.

Read the fixed `projectionLimits` from the App author context when choosing initial content or an App page size. The frozen values describe the full installed App projection. Use preparation results for actual capacity decisions. The Host budgets the assembled model input and output separately.

Trusted Hosts prepare candidates and adopt the complete request with `desktop.adoptTurn`. Call the resulting turn with the observation and tool IDs, the business `input`, and a separate `viewId` only for a multi-instance tool. Adopting a new turn revokes old calling eligibility. Publication and diagnostic preview leave adoption to the Host. The Runtime owns observation, invocation and Ref resolution for each actual App instance.

Verify first/last matching View activation, disabled/re-enabled Tools, correct and invalid Ref selections, optional absence, ordering and duplicates, business membership checks, updated View state and final resource release. Test through the matching actual SDK/Runtime packages; visibility or matching version strings alone do not prove compatibility.

The App owns business persistence. Use `launchConfig` for Host-provided paths and `registerCleanup({ close })` to join saves or release resources during shutdown. Confirm a save before the receipt promises that it completed. [IDE session persistence](../../../demo-apps/aotui-ide/README.md)
