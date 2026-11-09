---
name: aotui-app-builder
description: Use when designing or implementing an AOTUI application with @aotui/sdk, especially Root instructions, App-level ViewType Tools, typed Ref/ArrayRef selection, and progressive disclosure.
---

# AOTUI App Builder

Build applications for Agent use. Views present current state; Tools return concise receipts and update that state. Read the matching package's [author guide](../../../sdk/docs/view-type-tools.md), [Ref guide](../../../sdk/docs/readonly-ref-v2.md), and [API status](../../../sdk/docs/api-status.md). Use the [matching package guide](../../../sdk/docs/runtime-compatibility.md); an older installed package does not acquire current capabilities from newer docs.

## One declaration and one App binding

Declare metadata and the TypeBox Schema once with `defineViewTypeTool`, normally inside a module-level `defineToolSet`. Static definitions never have `execute`. Bind handlers once per App instance through one `AppTools` at a common ancestor; ordinary TypeScript uses the same controller through `createToolBindings` from `@aotui/sdk/tools`.

If a local capability label is useful, `ToolRef tool={tools.member}` may be placed inside a matching View. It presents a capability; it neither registers nor grants permission. Multiple Views of one type share a registration. Omitting ToolRef does not disable a bound Tool; use binding `enabled` and retain business checks. `ToolCatalog definition={tools}` lists only names grouped by ViewType in Root; it is not an active-tool or permission list. Full descriptions and schemas belong only in Context Tools. Do not serialize catalog descriptors into any View. Planning data Views show state and Refs without repeated tool lists.

Do not restore `useViewTypeTool`, `useViewSnapshotTool`, static `definition.execute`, dedicated Snapshot Tool parameters, hidden per-Tool registration components, or a second Hook/Provider authoring flow. Run the [complete AppTools example](../../../sdk/docs/examples/file-app.tsx); a plain TypeScript Producer uses the [file controller](../../../sdk/docs/examples/file-controller.ts) and supplies its existing port/publication boundary. The controller does not create a Host or private AppKernel.

## App metadata and result records

Keep author metadata in createTUIApp once. The repository's existing generate-aoapp script derives the distribution manifest from the built factory and package metadata. Build before installing a package through Registry; do not hand-maintain or reverse-import aoapp.json. Registry reads that static output without executing the App. Its canonical key must match app_name; Runtime owns the separate App/instance identities. Do not handwrite protocol markers or use state namespaces as execution IDs.

ToolResult is discriminated by success. A successful short receipt has success:true and optional JSON object data, without error/effects. A failure requires a plain JSON error record containing code and message, with optional JSON context and short recovery data. Use effects:'none' or 'partial' only when known; omit it when effects are uncertain. Do not return Error instances, stack/cause, functions or undefined. An unknown outcome is not permission to replay a business command. The current View remains the source of business data, separate from the receipt.

For the standard native Tool adapter choose ASCII letters, digits and underscores for Tool/ViewType names and keep the composed app-name/type/tool alias within 64 characters; the framework creates that alias. Do not parse it to route calls. Internal structured identities and Ref addresses retain their own contracts.

## Select published objects through Ref

For a business object already published as a Ref, show a meaningful description and its typed local Ref marker. The model passes view_id.local_ref without the display type prefix instead of copying internal plan_id, phase_id, task_id or uploading a payload. Runtime resolves against the invocation's adopted Observation; the handler receives recursively readonly business values. IDs can remain inside App state and Ref payloads.

Publish a single object with `useDataRef('current', value, { refType: 'Note' })`. Publish a list and its elements with `useArrayRef('notes', values, { itemType: 'Note' })`. Display names are `Note:current`, `Note[]:notes`, and `Note:notes[0]`; all have explicit metadata type Note. The payload Schema distinguishes the whole list from an element. A name prefix does not establish its type. These prefixes remain in display links; Tool input uses the containing View id plus the local name, e.g. notes_view.notes[0], without Note:.

```ts
import Type from 'typebox';
import { defineToolSet, defineViewTypeTool, refParam } from '@aotui/sdk/tools';

const Note = Type.Object({ id: Type.String(), title: Type.String() });
export const tools = defineToolSet({
  inspect: defineViewTypeTool({
    viewType: 'Notes', name: 'inspect', description: 'Inspect selected Notes; read Notes View.',
    inputSchema: Type.Object({
      selected: Type.Array(refParam('Note', Note), { maxItems: 50 }),
      whole: Type.Optional(refParam('Note', Type.Array(Note))),
      message: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
  }),
});
// In View id=notes_view; model: { selected: ['notes_view.notes[1]', 'notes_view.notes[0]'], whole: 'notes_view.notes' }
// Binding handler: selected is an ordered readonly array of Note objects;
// whole is the original readonly list if supplied, and absent otherwise.
```

- `refParam(type, ObjectSchema)` selects one object, including a natural ArrayRef element.
- `refParam(type, Type.Array(ObjectSchema))` selects one complete list Ref; its model input is one string.
- `Type.Array(refParam(...))` selects several complete Ref names; its model input is an array of strings. Order and duplicates remain; [] is a provided empty selection.
- `Type.Optional(...)` leaves omitted fields absent. Null, undefined, unknown or wrong-type Refs are not absence and reject the call.

Multiple, optional and selection fields compose at the Tool parameter root. Ref payloads support objects and object lists; nested Ref queries and primitive payloads are outside this profile. Normal parameter budgets apply to the complete resolved arguments and provenance, not separately to each selection. Multi-selection does not grant a business transaction or automatic deduplication.

The App still checks that resolved objects exist, belong to the intended current business context, and are permitted. Ref does not replace those checks or freeze the App's live data. Meaningful paths, titles, edit contents and amounts can remain ordinary fields. Readonly argument values do not constrain App business effects; authorization and current-state checks remain independent.

## Views and instructions

A View is an independent Agent work page. Always declare id, type, and kind="instruction" or kind="state" explicitly; instance ID does not determine type, and descendants do not determine kind. Never nest View inside View; declare related Views as siblings. Ordinary Preact components and DOM elements can nest within one View. Use semantic text tags rather than CSS or layout-only markup to convey meaning.

Submit an unwrapped, unescaped Markdown body; the final Runtime message boundary encodes XML text exactly once, including CR/CRLF, and Host preview decodes once. Use pre/code for exact file, patch and log text; do not trim or XML-escape it yourself. See the [View contract](../../../sdk/docs/views.md).

Keep Root instructions in English unless the application requires another language. Explain:

- What the application does and the normal workflow.
- Which ViewTypes are currently relevant and which Tools apply to each.
- The containing View id and local Ref names used to select existing objects and how to recover after an invalid choice.
- Where to inspect the resulting current state after a receipt.

Keep the Schema, handler, rendered references and recovery guidance in agreement. Do not hide IDs in text while still requiring them as model inputs. Keep business data in View instead of duplicating its current contents in a receipt.

## Submission, observation and checks

Render captures candidate bindings; AppTools commits through the shared controller and projection boundary. Do not update the Registry or committed handler during render. A Tool receipt alone is not a claim that an unfinished App update is visible.

Trusted Host consumers prepare an Observation, explicitly adopt it, then invoke its binding. Adoption of a new Observation revokes the previous calling eligibility; publication and diagnostic preview alone do not adopt. Independent Scope holders retain their own qualification. Apps do not manufacture observationId/bindingId or implement a private Ref resolver.

Verify first/last matching View activation, disabled/re-enabled Tools, correct and invalid Ref selections, optional absence, ordering and duplicates, business membership checks, updated View state and final resource release. Test through the matching actual SDK/Runtime packages; visibility or matching version strings alone do not prove compatibility.

The [complete Notes example](../../../sdk/docs/examples/ref-app.tsx) demonstrates object, whole-list, element, multiple, optional and ordered repeated selection inputs. Note and NoteDetail are example business names, not framework concepts. Keep complete runnable code in these example files rather than duplicating another tutorial implementation.
