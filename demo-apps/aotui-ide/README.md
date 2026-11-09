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

Opening files publishes FileDetail Views and makes the IDE's FileDetail Tool set available. The IDE registers one App-level set for the `FileDetail` ViewType; ten open files still share one `edit_file`, one `write_file`, one `rename_file`, and one `delete_file` declaration. Each Tool call takes an explicit business path (`filePath`, or `oldPath`/`newPath` for rename), and the IDE checks it against its current loaded-file records. The SDK does not infer a file target from which View displayed the Tool.

File contents, search matches and LSP results appear in their current Views. Successful search, LSP and batch Tool results carry receipts rather than duplicate result collections. Receipts point to the actual FileDetail ID while that View remains current; delete/close receipts point to Workspace, and a failed View refresh preserves its warning and points to Workspace for recovery.

See [SCOPED_IDE.md](./SCOPED_IDE.md) for tool contracts, limits and cleanup, and [Semantic Host integration](../../runtime/docs/semantic-host-integration.zh-CN.md) for context ownership and outcomes. Legacy data import, when configured, is a data migration; it is not an alternate app entry.

## Runtime Requirements

- Matching SDK 0.8.0-srt.1 and Runtime 7.0.0-srt.1 delivery artifacts with the `view-type-tools-v4` authoring protocol, `view-type-parameters-v1` ordinary/Ref parameters, Snapshot 3, and `app-lifecycle-v2` contracts. `createTUIApp` writes the authoring marker; Runtime rejects an older or mismatched factory before initialization. Version numbers alone are insufficient; install artifacts from one compatible delivery.
- TypeBox 1.4.3 for the IDE's single-source Tool parameter declarations.
- Optional local language servers for advanced code intelligence

The default JavaScript/TypeScript backend is the pinned native 7.0.2 candidate with a same-version shutdown backport, currently qualified on darwin-arm64. Installed App artifacts include the executable; source builds require Go 1.26.2.

See [LSP_SETUP.md](./LSP_SETUP.md) for language server configuration details.
