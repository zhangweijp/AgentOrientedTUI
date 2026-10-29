---
name: aotui-app-builder
description: This skill should be used when designing or implementing an AOTUI TUI application with @aotui/sdk, especially when defining Root View instructions, View Type tools, and progressive disclosure behavior for LLM-facing markdown UI.
---

# AOTUI App Builder

## Overview

Design and implement an AOTUI TUI application using @aotui/sdk with a Root View that aggregates instructions and View Type tools, while Views render data and tool results as markdown-friendly HTML.

## When To Use

Apply this skill when building, redesigning, or extending an AOTUI TUI app, or when defining Root View instructions, View Type tool contracts, or progressive disclosure by active Views.

## Workflow

1. Identify data models first
   - Locate runtime SPI interfaces and SDK View/Operation contracts.
   - Map domain entities to View types and Operation inputs/outputs.
2. Define the View system
   - List all View types and decide which are fixed vs dynamic.
   - Define each View’s responsibility as result presentation, not tool execution.
3. Design Root View instruction structure
   - Define App Instruction and per-View Instruction sections.
   - Add Available Tools only for View types that are currently mounted.
4. Define tool contracts
   - Use View Type tools for domain actions.
   - Put “When to use” and “How to use” inside the tool description.
5. Implement Views and tool handlers
   - Render only markdown-friendly HTML tags.
   - Return concise tool results that point to the View where details appear.
6. Verify progressive disclosure
   - Ensure Root View only shows sections for mounted View types.
   - Ensure tool invocations mutate View data or View count.

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

```
<View id="<view_id>" type="<View Type>" name="<Display Name>">
  <ViewContent ... />
</View>

useViewTypeTool('<View Type>', '<tool_name>', {
  description: `<When to use: ...>
<How to use: ...>`,
  params: defineParams({
    ...
  })
}, async (args) => {
  return {
    success: true,
    data: {
      message: 'Result written to <View Type> view',
      view_id: '<view_id>'
    }
  }
})
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

1. Treat tools as query commands and Views as query results
   - Return success or failure plus where to read the result.
   - Show the data change in the View content or by mounting/dismounting Views.
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
   - View id/type rules, ViewRuntimeContext usage, view-level state.
3. Tool layer
   - useViewTypeTool, params schema, success/error payload shape.
4. Data layer
   - View data rendering and change propagation patterns.
5. Advanced layer
   - multiple dynamic views, cross-view eventing, performance controls.

Load detailed API notes from references/sdk_api.md only when the task requires explicit API usage.

## SDK Implementation Outline

1. Create the app factory with createTUIApp.
2. Render a Root View and domain Views.
3. Use View Type tools for domain actions.
4. Update View data after tool execution and trigger re-render.

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
  name: 'My AOTUI App',
  component: AppRoot
})
```

## App Template Reference

Use the SystemIDEApp view layout as a template for multi-view apps.

Reference: /Users/zhangwei/JSWorkSpace/learning_code/aotui_v6/aotui-ide/src/tui/SystemIDEApp.tsx#L174-237

## Output Checklist

- Provide Root View instruction structure in English.
- Ensure tools return concise status plus the target View for details.
- Ensure every tool modifies View data or View count.
- Ensure only markdown-friendly HTML tags are used.
