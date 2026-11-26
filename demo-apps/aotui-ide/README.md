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

The package exports its managed scoped IDE factory as the default entry. The Host installs it by registering the package on a Desktop and using the Semantic Source. The standard launch configuration accepts `projectPath`, `ideSessionKey`, `AOTUI_DATA_DIR` and `ideHistoryPath`.

Opening files publishes FileDetail Views and makes the IDE's FileDetail Tool set available. The IDE registers one App-level set for the `FileDetail` ViewType; ten open files still share one `edit_file`, one `write_file`, one `rename_file`, and one `delete_file` declaration. A FileDetail Tool chooses the receiving file by the page's XML `view_id`. Workspace commands take their declared business parameters, including file paths when they identify files. The IDE checks loaded-file identity and disk state before writing.

File contents, search matches and LSP results appear in their current Views. Successful search, LSP and batch Tool results carry receipts rather than duplicate result collections. Receipts point to the actual FileDetail ID while that View remains current; delete/close receipts point to Workspace, and a failed View refresh preserves its warning and points to Workspace for recovery.

See [SCOPED_IDE.md](./SCOPED_IDE.md) for tool contracts, limits and cleanup. Host usage and outcomes are in the [Runtime README](../../runtime/README.md).

## Runtime Requirements

- Node.js 22.13 or newer for the built-in SQLite write reservations.
- Matching SDK 0.9.0 and Runtime 8.0.0 artifacts from one delivery. The IDE uses `view-type-tools-v7` authoring, native value and Ref parameters, Snapshot 7, and `app-lifecycle-v2`. Runtime checks the `createTUIApp` authoring marker before initialization.
- TypeBox 1.4.3 for the IDE's single-source Tool parameter declarations.
- Optional local language servers for advanced code intelligence

The default JavaScript/TypeScript backend is the pinned native 7.0.2 candidate with a same-version shutdown backport, currently qualified on darwin-arm64. Installed App artifacts include the executable; source builds require Go 1.26.2.

See [LSP_SETUP.md](./LSP_SETUP.md) for language server configuration details.
