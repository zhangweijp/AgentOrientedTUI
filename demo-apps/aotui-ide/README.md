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

## Default Semantic integration

The package default, `SystemIDEApp`, and generated aoapp now use the scoped implementation. Normal Host startup installs the IDE through AppRegistry and the same Semantic Source used by Terminal and Browser; no IDE-specific Source or development flag is required.

Opening a file publishes a FileDetail View and its edit/write/rename/delete tools. These tools target the captured View instance, so their arguments do not repeat a file path. Closing the file removes its tools and invalidates its old bindings. File contents appear in the latest View; tool results report the operation outcome.

See [SCOPED_IDE.md](./SCOPED_IDE.md) for tool contracts, limits and cleanup, and [Semantic Host integration](../../runtime/docs/semantic-host-integration.zh-CN.md) for context ownership and outcomes. Legacy remains an explicit historical entry pending user acceptance and removal; normal startup never falls back to it.

## Runtime Requirements

- Matching Runtime / SDK delivery artifacts with ordinary-v2 and app-lifecycle-v2 support; the optional diagnostics slice also needs ordinary-v1. The standard Host negotiates these capabilities. Version numbers alone are insufficient.
- Optional local language servers for advanced code intelligence

See [LSP_SETUP.md](./LSP_SETUP.md) for language server configuration details.
