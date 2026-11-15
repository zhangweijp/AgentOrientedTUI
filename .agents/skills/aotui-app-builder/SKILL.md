---
name: aotui-app-builder
description: Use when designing or implementing an AOTUI application with @aotui/sdk, especially Root instructions, shared ViewType declarations and per-View tool handlers, typed Ref/ArrayRef selection, and progressive disclosure.
---

# AOTUI App Builder

Build applications for Agent use. Views present current state. Tools return concise receipts. Start with the matching package's [App author guide](../../../sdk/docs/app-authoring.md), [Ref guide](../../../sdk/docs/readonly-ref-v2.md), and [API status](../../../sdk/docs/api-status.md). Use the [matching package guide](../../../sdk/docs/runtime-compatibility.md) for build and runtime setup.

## Declare the type and bind each page

Use `defineViewType({ name, tools })` for one shared set of business schemas and descriptions. List the descriptors in the App factory's `viewTypes`. Preact pages provide `View.bindings`. Plain TypeScript pages use a stable `createView(type, { id, kind, render })` handle. The render result supplies body, refs, and bindings. Call `publish({ views })` with all open handles.

Each page supplies a complete set of handlers and uses `enabled: false` for an unavailable operation. Native Tool calls require the receiving page's XML `view_id`. The business Schema and the handler arguments contain just the business fields.

Use `<ToolCatalog viewTypes={viewTypes} />` in Root to list the shared names. The model request carries available operations and their schemas. Run the [plain TypeScript](../../../sdk/docs/examples/work-items-plain.ts) or [Preact](../../../sdk/docs/examples/work-items-preact.tsx) example through the matching SDK and Runtime.

## App metadata and result records

Keep author metadata in `createApp` or `createTUIApp` once. Build the factory, then use the repository's `generate-aoapp` script to derive the manifest from the built factory and package metadata. Registry reads the static manifest. Its canonical key must match `app_name`. Runtime owns the separate App and instance identities.

ToolResult is discriminated by success. A successful short receipt has success:true and optional JSON object data, without error/effects. A failure requires a plain JSON error record containing code and message, with optional JSON context and short recovery data. Record known recovery details in the receipt. Do not return Error instances, stack/cause, functions or undefined. An unknown outcome is not permission to replay a business command. The current View remains the source of business data, separate from the receipt.

For the standard native Tool adapter choose ASCII letters, digits and underscores for Tool/ViewType names and keep the composed app-name/type/tool alias within 64 characters; the framework creates that alias. Do not parse it to route calls. Internal structured identities and Ref addresses retain their own contracts.

## Select published objects through Ref

For a business object already published as a Ref, show a meaningful description and its typed local Ref marker. The model passes view_id.local_ref without the display type prefix instead of copying internal plan_id, phase_id, task_id or uploading a payload. Runtime resolves against the invocation's adopted Observation; the handler receives recursively readonly business values. IDs can remain inside App state and Ref payloads.

In plain TypeScript, put `ref('current', value, { refType: 'Note' })` or `arrayRef('notes', values, { itemType: 'Note' })` in the View's `refs` and use `formatRef` to render links. In Preact, use `useDataRef` or `useArrayRef` with the same options. Each helper accepts an optional TypeBox source schema. `arrayRef` and `useArrayRef` publish both the whole list and its elements. Display names include `Note:current`, `Note[]:notes`, and `Note:notes[0]`. All three examples use explicit metadata type `Note`. The model passes addresses such as `notes_view.notes[0]`.

```ts
import Type from 'typebox';
import { defineViewType, refParam } from '@aotui/sdk/app';

const Note = Type.Object({ id: Type.String(), title: Type.String() });
export const Notes = defineViewType({ name: 'Notes', tools: {
  inspect: {
    description: 'Inspect selected Notes; read Notes View.',
    inputSchema: Type.Object({
      selected: Type.Array(refParam('Note', Note), { maxItems: 50 }),
      whole: Type.Optional(refParam('Note', Type.Array(Note))),
      message: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
  },
} });
// In View id=notes_view; model: { view_id: 'notes_view', selected: ['notes_view.notes[1]', 'notes_view.notes[0]'], whole: 'notes_view.notes' }
// Binding handler: selected is an ordered readonly array of Note objects;
// whole is the original readonly list if supplied, and absent otherwise.
```

- `refParam(type, ObjectSchema)` selects one object, including a natural ArrayRef element.
- `refParam(type, Type.Array(ObjectSchema))` selects one complete list Ref; its model input is one string.
- `Type.Array(refParam(...))` selects several complete Ref names; its model input is an array of strings. Order and duplicates remain; [] is a provided empty selection.
- `Type.Optional(...)` leaves omitted fields absent. An explicit Ref input must be a valid address string even when the selected JSON value is null.

Multiple, optional and selection fields compose at the Tool parameter root. A Ref may select any supported JSON value, including a scalar, null, a nested object, or an array. The target schema validates the selected value after dereferencing. The complete invocation shares one parameter budget. See the [local schema profile](../../../sdk/docs/tool-parameters.md).

The App still checks that resolved objects exist, belong to the intended current business context, and are permitted. Ref does not replace those checks or freeze the App's live data. Meaningful paths, titles, edit contents and amounts can remain ordinary fields. Readonly argument values do not constrain App business effects; authorization and current-state checks remain independent.

## Views and instructions

A View is an independent Agent work page. Declare `id`, `type`, and `kind` (`instruction` or `state`) explicitly. In plain TypeScript provide a Markdown `body`. In Preact use sibling `View` components for distinct pages and semantic text tags within a page.

Submit an unwrapped, unescaped Markdown body; the final Runtime message boundary encodes XML text exactly once, including CR/CRLF, and Host preview decodes once. Use pre/code for exact file, patch and log text; do not trim or XML-escape it yourself. See the [View contract](../../../sdk/docs/views.md).

Keep Root instructions in English unless the application requires another language. Explain:

- What the application does and the normal workflow.
- Which ViewTypes are currently relevant and which Tools apply to each.
- The containing View id and local Ref names used to select existing objects and how to recover after an invalid choice.
- Where to inspect the resulting current state after a receipt.

Keep the Schema, handler, rendered references and recovery guidance in agreement. Do not hide IDs in text while still requiring them as model inputs. Keep business data in View instead of duplicating its current contents in a receipt.

## Submission, observation and checks

In plain TypeScript, each `publish` supplies all current Views, their Refs and Tool bindings. Omitted Views and Refs leave the projection on a successful commit. A failed frame retains prior identities and pauses new dispatch until a valid frame is accepted. In Preact, `View.bindings` and Ref hooks participate in the actual render commit. A Tool receipt describes the operation. The next successful observation establishes current View visibility.

Trusted Host consumers prepare an Observation, explicitly adopt it, then invoke with its Observation ID, Tool ID, and receiving View ID. Adoption of a new Observation revokes the previous calling eligibility; publication and diagnostic preview alone do not adopt. The Runtime owns observing, invoking, and resolving Refs for each App instance.

Verify first/last matching View activation, disabled/re-enabled Tools, correct and invalid Ref selections, optional absence, ordering and duplicates, business membership checks, updated View state and final resource release. Test through the matching actual SDK/Runtime packages; visibility or matching version strings alone do not prove compatibility.

The [complete Notes example](../../../sdk/docs/examples/ref-app.tsx) demonstrates object, whole-list, element, multiple, optional and ordered repeated selection inputs. Note and NoteDetail are example business names, not framework concepts. Keep complete runnable code in these example files rather than duplicating another tutorial implementation.
