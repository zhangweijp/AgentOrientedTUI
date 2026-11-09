Build app.tsx using only the installed public @aotui/sdk API, Preact and TypeBox 1.4.3. Read public-docs/view-type-tools.md and public-docs/examples/file-app.tsx first.

Export a module-static ToolSet named fileTools and default-export the managed createTUIApp factory. Use one AppTools at the common ancestor, ToolRef in the matching Views and ToolCatalog for the static capabilities.

The app is an in-memory document editor. Initially a.txt and b.txt are both open, with contents INITIAL_A and INITIAL_B, stable View IDs file_a and file_b and type FileDetail. There is always a workspace View (ID workspace, type Workspace) and a Root instruction View. No nested Views.

Define exactly three ordinary Tools:
- Workspace/open_file: {filePath:string}; reopen a.txt or b.txt with its stable View ID; reject other paths.
- Workspace/close_file: {filePath:string}; close the named open document.
- FileDetail/edit_file: {filePath:string,content:string}; replace an open document's content.

All three schemas are closed objects. Choose the business object from the explicit filePath, never from a UI position or framework target. If an edit or close names a document that is no longer open, return success:false, effects:none, error.code FILE_NOT_OPEN. In particular, closing b while a stays open must leave one shared edit Tool; calling that Tool for b must fail in the App. Reopening gets fresh Framework qualifications when appropriate. Return concise receipts without echoing the content; put the latest text in the FileDetail View. The static catalog must not change as files close/open or handlers update.

Use accurate public types, with no any, unsafe type coercion, compiler suppressions, private imports or hand-written registration/permission machinery. Do not inspect SDK/Runtime implementation JS or any repository outside this evaluation directory; public docs and public .d.ts are available. No network or delegation. Implement only app.tsx; do not change package.json, tsconfig.json, AGENTS.md or the evaluator. You may run local compilation as a self-check. External evaluation allows at most two repair feedback turns after this initial attempt.
