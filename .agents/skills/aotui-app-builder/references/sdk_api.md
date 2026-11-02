## SDK API Reference

Use this reference only when explicit API usage is required. Keep responses concise and focus on how API choices affect Root View, View rendering, and tool behavior.

### createTUIApp

When to use:
- Create the entry factory for any AOTUI app.
- Bind the canonical app name, root component, and launch configuration.

How to use:
- Pass `app_name` and `component` at minimum.
- Add launchConfig to expose environment values to the app.

Example:

```tsx
import { createTUIApp } from '@aotui/sdk'

export default createTUIApp({
  app_name: 'my_app',
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
- Define a Tool for the currently mounted View instance.
- Call the Hook inside a component rendered under its owning `<View>`.

How to use:
- Put “When to use” and “How to use” inside description.
- Return a concise receipt and put current business data in the View.

Example:

```tsx
import { useViewTypeTool } from '@aotui/sdk'

type WorkspaceToolsProps = {
  searchFilesByPattern: (pattern: string) => Promise<readonly string[]>
  setSearchResults: (results: readonly string[]) => void
}

// Render WorkspaceTools inside the component tree of the Workspace <View>.
function WorkspaceTools({ searchFilesByPattern, setSearchResults }: WorkspaceToolsProps) {
  useViewTypeTool('search_files_by_pattern', {
    description: `When to use: Locate files by pattern.
How to use: Provide a glob pattern, then read the SearchResult View.`,
    params: {
      pattern: { type: 'string', required: true, desc: 'Glob pattern' }
    },
    isMutating: true,
  }, async ({ pattern }) => {
    const results = await searchFilesByPattern(pattern)
    setSearchResults(results)
    return {
      success: true,
      data: { message: 'Search results are available in the SearchResult View.' }
    }
  })
  return null
}
```

### Tool parameter schemas

Pass a parameter object directly in the `params` field of `useViewTypeTool`.
TypeScript infers argument types from that object; Runtime compiles and validates
the execution contract when the Tool is registered.

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

### useAppRuntimeContext

When to use:
- Read the current App metadata, launch configuration, and managed persistence context.

Example:

```tsx
import { useAppRuntimeContext } from '@aotui/sdk'

const launchConfig = useAppRuntimeContext().launchConfig
const projectPath = typeof launchConfig?.projectPath === 'string'
  ? launchConfig.projectPath
  : process.cwd()
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
  app_name: 'aotui_ide',
  component: AppRoot
})
```
