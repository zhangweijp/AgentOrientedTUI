# @agentina/aotui-ide

AOTUI IDE is an Agent-Oriented TUI application for browsing repositories, searching files, editing code, and using LSP-assisted code intelligence from inside Agentina.

## Install

```bash
agentina install @agentina/aotui-ide
```

## Features

- Browse and inspect workspace files
- Search by filename or content
- Read and edit files
- Persist open files by workspace
- Use LSP for hover, definitions, references, diagnostics, and symbols

## Package default

The package has one default managed factory built with `createTUIApp` and backed by `ScopedIDEApp`. Normal Host startup installs this package entry through AppRegistry and the generic Semantic Source; there is no route-specific app entry or IDE-only Runtime mode.

Opening a file publishes a FileDetail View and its edit/write/rename/delete tools. View Type Tool selectors bind those calls to the mounted FileDetail; `write_file`, `edit_file`, and `delete_file` still require `filePath`, while `rename_file` requires `oldPath` and `newPath`. The app checks those paths against its loaded file identity before changing the file. Closing the View removes its tools and invalidates its old bindings. File contents appear in the latest View; tool results report the operation outcome.

See [SCOPED_IDE.md](./SCOPED_IDE.md) for tool contracts, limits and cleanup, and [Semantic Host integration](../../runtime/docs/semantic-host-integration.zh-CN.md) for context ownership and outcomes. Legacy data import, when configured, is a data migration; it is not an alternate app entry.

## Runtime Requirements

- Matching Runtime / SDK delivery artifacts with the formal `ordinary-v2`, `snapshot-value-v2`, and `app-lifecycle-v2` contracts. The optional diagnostics slice also uses ordinary-v2. Version numbers alone are insufficient.
- Optional local language servers for advanced code intelligence

See [LSP_SETUP.md](./LSP_SETUP.md) for language server configuration details.
