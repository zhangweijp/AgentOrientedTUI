---
name: aotui-app-builder
description: This skill should be used when designing or implementing an AOTUI TUI application with @aotui/sdk, especially when defining Root View instructions, View-local Tools, and progressive disclosure behavior for LLM-facing markdown UI.
---

# AOTUI App Builder

## Overview

Design and implement an AOTUI TUI application using `@aotui/sdk`. View-local Tools describe and perform app operations; Views present the current business state and useful outcomes.

## When To Use

Apply this skill when building, redesigning, or extending an AOTUI TUI app, or when defining Root View instructions, View-local Tool contracts, or progressive disclosure by active Views.

## Workflow

1. Identify data models and ownership first
   - Locate SDK View and View-local Tool contracts.
   - Keep domain validation, file identity, concurrency, and resource effects in the app or its resource adapter.
   - Map user-visible state to Views and action inputs/results to Tool contracts.
2. Define the View system
   - List all View types and decide which are fixed vs dynamic.
   - Define each View’s responsibility as result presentation, not tool execution.
3. Design Root View instruction structure
   - Define App Instruction and per-View Instruction sections.
   - Add Available Tools only for View types that are currently mounted.
4. Define Tool contracts
   - Call `useViewTypeTool(name, options, handler, config?)` inside a component rendered under the owning `<View>`. It binds to that mounted View instance; it is not a type-wide registration.
   - Ordinary parameters, including empty and read-only parameters, use the negotiated `ordinary-v2` contract and can support reads or mutations.
   - A snapshot Ref parameter must be required and read-only, set `refSource: 'snapshot-value-v1'`, and use `isMutating: false`. This is provenance metadata; the trusted Host enables execution through `snapshot-value-v2`.
   - Put actionable “When to use” and “How to use” guidance in the Tool description.
5. Implement Views and tool handlers
   - Render only markdown-friendly HTML tags.
   - Return an `OperationResult` with concise receipt data; put the current business state in its View.
6. Verify progressive disclosure
   - Ensure Root View only shows sections for mounted View types.
   - Ensure reads and mutations present business data through the current View; Tool results remain concise receipts.

## Root View Specification

Produce a Root View that is a single source of instruction for the app. Keep the language in English and structure it as follows:

```
# <APP NAME> Application Instruction
## What <APP NAME> is
## How to use <APP NAME>
## Views of <APP NAME>
### <View Type A>
#### <View Type A> Instruction
#### <View Type A> Available Tools
### <View Type B>
#### <View Type B> Instruction
#### <View Type B> Available Tools
```

Apply progressive disclosure so that each View Type section is rendered only when at least one View instance of that type is mounted.

## Root View Generator

Use the template below to generate a Root View instruction block and a View/Tool skeleton. Fill only the sections that correspond to mounted View types.

Root View template:

```
# <APP NAME> Application Instruction
## What <APP NAME> is
<one paragraph>
## How to use <APP NAME>
<bulleted usage steps>
## Views of <APP NAME>
### <View Type A>
#### <View Type A> Instruction
<what the view shows and how it updates>
#### <View Type A> Available Tools
- <tool_name_a>
- <tool_name_b>
### <View Type B>
#### <View Type B> Instruction
<what the view shows and how it updates>
#### <View Type B> Available Tools
- <tool_name_c>
```

View and tool skeleton:

```tsx
function ViewTools() {
  useViewTypeTool('<tool_name>', {
    description: `<When to use: ...>
<How to use: ...>`,
    params: {
      ...
    },
    isMutating: true,
  }, async (args) => ({
    success: true,
    data: { message: 'Operation completed' },
  }))
  return null
}

function WorkspaceView() {
  return (
    <View id="<view_id>" type="<View Type>" name="<Display Name>">
      <ViewContent />
      <ViewTools />
    </View>
  )
}
```

## Root View Generator Example

Generate an AOTUI IDE style skeleton when requested.

```
# AOTUI IDE Application Instruction
## What AOTUI IDE is
Provide a TUI workspace for browsing, searching, and inspecting files.
## How to use AOTUI IDE
- Start in Workspace to browse files and open details.
- Use Search Result to navigate matches.
## Views of AOTUI IDE
### Workspace View
#### Workspace Instruction
Show file tree and allow file open/close actions.
#### Workspace Available Tools
- open_file
- search_files_by_pattern
### File Detail View
#### File Detail Instruction
Show file content and analysis results.
#### File Detail Available Tools
- lsp_hover
- lsp_goto_definition
### Search Result View
#### Search Result Instruction
Show query results and navigation links.
#### Search Result Available Tools
- close_search_view
```

## Tool And View Principles

1. Keep operation receipts separate from current business state
   - Return success or failure plus concise recovery information.
   - Show changed business data through the current View; do not duplicate its full content in Tool results.
2. Put operational guidance in tool descriptions
   - Include “When to use” and “How to use” inside the tool description.
   - Avoid repeating tool descriptions in the Root View; list tool names only.
3. Use markdown-friendly HTML tags only
   - Prefer h1–h6, p, ul, ol, li, table, tr, th, td, pre, code, strong, em, blockquote.
   - Avoid CSS and avoid layout-only tags for content.

## Progressive Disclosure Pattern

Implement Root View sections based on mounted View types. Use the active view state to decide visibility.

Example logic guidance:
- If no SearchResult view exists, omit the SearchResult section from Root View.
- If multiple FileDetail views exist, show a single FileDetail section and list available view ids.

## Progressive Disclosure For SDK API

Reveal SDK guidance in layers based on task scope, and only load deeper details when needed.

1. Core layer
   - createTUIApp, View, Root View instruction layout.
2. View layer
   - View id/type rules, `useViewContext`, and view-local state.
3. Tool layer
   - the View-local `useViewTypeTool` Hook, parameter schema, and receipt result shape.
4. Data layer
   - View data rendering and change propagation patterns.
5. Advanced layer
   - multiple dynamic views, cross-view eventing, performance controls.

For exact exported names or migration details, consult the SDK's [API status](../../../sdk/docs/api-status.md) and [migration guide](../../../sdk/docs/migration.md) when the task requires them.

## SDK Implementation Outline

1. Create the app factory with createTUIApp.
2. Render a Root View and domain Views.
3. Declare each domain Tool inside the component rendered by its owning View.
4. Update the app's business state after a successful mutation so the current View presents the result.

Example outline:

```tsx
import { createTUIApp, View, useState, useMemo, useEffect } from '@aotui/sdk'

function AppRoot() {
  const [items, setItems] = useState([])
  return (
    <>
      <View id="root" type="Root" name="Root">
        <RootView items={items} />
      </View>
      <View id="workspace" type="Workspace" name="Workspace">
        <WorkspaceView items={items} />
      </View>
    </>
  )
}

export default createTUIApp({
  app_name: 'my_aotui_app',
  component: AppRoot
})
```

`createTUIApp` returns the managed `app-lifecycle-v2` factory by default. A component that owns resources can register `useAppLifecycle({ stop?, close? })`; apps without owned cleanup do not need the hook or a lifecycle config flag.

## App Template Reference

Use this repository's [ScopedIDEApp](../../../demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx) as a current multi-view example. It shows the managed package default, Root View instructions, progressive disclosure, FileDetail target selectors, View-local Tools, and the formal app lifecycle hook.

## Output Checklist

- Provide Root View instruction structure in English.
- Ensure tools return concise status plus the target View for details.
- For each mutating Tool, ensure the resulting business state is reflected in the current View.
- Ensure only markdown-friendly HTML tags are used.
