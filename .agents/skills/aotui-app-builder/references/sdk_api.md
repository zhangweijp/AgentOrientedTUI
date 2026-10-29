## SDK API Reference

Use this reference only when explicit API usage is required. Keep responses concise and focus on how API choices affect Root View, View rendering, and tool behavior.

### createTUIApp

When to use:
- Create the entry factory for any AOTUI app.
- Bind the app name, root component, and launch configuration.

How to use:
- Pass name and component at minimum.
- Add launchConfig to expose environment values to the app.

Example:

```tsx
import { createTUIApp } from '@aotui/sdk'

export default createTUIApp({
  name: 'My App',
  component: AppRoot,
  launchConfig: {
    workspace_dir_path: process.env.WORKSPACE_DIR || process.cwd()
  }
})
```

### View

When to use:
- Define a renderable region that maps to a View in the runtime snapshot.
- Use Root view to expose instructions and tools.

How to use:
- Provide id and type for grouping.
- Use Root as the instruction hub and other Views as result displays.

Example:

```tsx
import { View } from '@aotui/sdk'

<View id="workspace" type="Workspace" name="Workspace">
  <WorkspaceView />
</View>
```

### useViewTypeTool

When to use:
- Define a tool bound to a View type.
- Expose tool usage to Root View without duplicating descriptions.

How to use:
- Put “When to use” and “How to use” inside description.
- Return minimal success info and point to the View for results.

Example:

```tsx
import { useViewTypeTool, defineParams } from '@aotui/sdk'

useViewTypeTool('Workspace', 'search_files_by_pattern', {
  description: `When to use: Locate files by pattern.
How to use: Provide a glob pattern and check Search Result view.`,
  params: defineParams({
    pattern: { type: 'string', required: true, desc: 'Glob pattern' }
  })
}, async (args) => {
  return {
    success: true,
    data: { message: 'Search results written to SearchResult view' }
  }
})
```

### defineParams

When to use:
- Define a tool parameter schema for validation and metadata.

How to use:
- Provide type, required, and description for each field.
- Use array/object types for structured inputs.

Example:

```tsx
import { defineParams } from '@aotui/sdk'

const params = defineParams({
  file_path: { type: 'string', required: true, desc: 'Absolute path' },
  line: { type: 'number', required: true, desc: '1-based line' }
})
```

### useState / useEffect / useMemo / useCallback

When to use:
- Manage view-local data, react to external events, and memoize helpers.

How to use:
- Keep View data minimal and render the latest state.
- Trigger tool-driven updates through state changes.

Example:

```tsx
import { useState, useEffect } from '@aotui/sdk'

const [items, setItems] = useState<string[]>([])
useEffect(() => {
  setItems([])
}, [])
```

### useAppEnv

When to use:
- Access launchConfig values from Root or other Views.

How to use:
- Request by key and provide a fallback.

Example:

```tsx
import { useAppEnv } from '@aotui/sdk'

const workspacePath = useAppEnv<string>('projectPath') || process.cwd()
```

## Demo: AOTUI IDE Style App Skeleton

Use the following layout as a baseline for multi-view apps.

```tsx
import { createTUIApp, View, useState, useMemo } from '@aotui/sdk'

function AppRoot() {
  const [activeFiles, setActiveFiles] = useState<string[]>([])
  const [searchResultView, setSearchResultView] = useState<{ query: string; results: string[] } | null>(null)
  const eventBus = useMemo(() => ({}) as any, [])

  return (
    <>
      <View id="root" type="Root" name="Root">
        <RootView
          activeFiles={activeFiles}
          searchResultView={searchResultView}
          eventBus={eventBus}
        />
      </View>

      <View id="workspace" type="Workspace" name="Workspace">
        <WorkspaceContent activeFiles={activeFiles} eventBus={eventBus} />
      </View>

      {activeFiles.map((filePath, index) => (
        <View
          key={filePath}
          id={`fd_${index}`}
          type="FileDetail"
          name={`File: ${filePath.split('/').pop()}`}
        >
          <FileDetailContent initialFilePath={filePath} eventBus={eventBus} />
        </View>
      ))}

      {searchResultView && (
        <View id="search" type="SearchResult" name="Search Results">
          <SearchResultView
            searchQuery={searchResultView.query}
            results={searchResultView.results}
          />
        </View>
      )}
    </>
  )
}

export default createTUIApp({
  name: 'AOTUI IDE',
  component: AppRoot
})
```
