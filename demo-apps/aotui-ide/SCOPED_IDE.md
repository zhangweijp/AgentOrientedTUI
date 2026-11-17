# AOTUI IDE package integration

The package exports a default managed `TUIAppFactory`, created with `createTUIApp` and backed by `ScopedIDEApp`. It has one business owner per App and uses instance-bound Runtime interaction, committed snapshots and managed app state. Normal Host startup uses standard AppRegistry installation and the generic Semantic Source. [Runtime README](../../runtime/README.md)

The current authoring contract uses SDK 0.9.0 with Runtime 8.0.0. `createTUIApp` supplies `toolAuthoringProtocol: 'view-type-tools-v6'`, which Runtime checks when it loads the factory. The IDE declares Tool inputs once with TypeBox 1.4.3 and supplies per-page context. [SDK README and runnable App](../../sdk/README.md)

## Standard installation and explicit custom hosts

Install Runtime, SDK and IDE packages from a compatible delivery. Published packages with identical version numbers do not prove support for the current contracts.

```ts
import { createDesktopId, createRuntime } from '@aotui/runtime';

const runtime = createRuntime();
const desktopId = await runtime.createDesktop(createDesktopId('dt_my-ide'));
const appModulePath = import.meta.resolve('@agentina/aotui-ide');
const appId = await runtime.installDynamicWorkerApp(desktopId, appModulePath, {
    appId: 'my-ide',
    config: {
        projectPath: '/absolute/project',
        ideSessionKey: 'my-project',
        ideHistoryPath: '/absolute/app-data/ide-history.json',
        AOTUI_DATA_DIR: '/absolute/app-data',
        enableDiagnosticsRead: true,
        enableWorkspaceCreate: true,
    },
});
```

Replace the absolute paths with an existing project directory and a writable data location. Tool execution is enabled by default. Set `toolsEnabled: false` on the installation options to keep View observation and preview read-only. Ordinary and Ref parameters share `view-type-parameters-v1` and use the `view-tool-parameters-invoke/v6` Worker capability. When the Host finishes, await `runtime.beginShutdown().completion` and inspect its report.

The normal Host supplies App identity, Desktop identity, project path and managed persistence through AppContext. By default, the IDE derives its session key from the Desktop ID and the assigned App ID, and stores history under `AOTUI_DATA_DIR/ide-sessions/<sessionKey>/history.json`. A different App installation order can change the assigned ID and the default path. Explicit `ideSessionKey` values use 1–128 ASCII letters, digits, underscores, dots or hyphens. Explicit `ideHistoryPath` values must be absolute. Give concurrent independent Apps distinct session keys. Recent history uses a cooperative lock/CAS and reports conflicts and warnings.

## All tools and business targets

All page Tool calls require the receiving View's XML `view_id` in addition to the business arguments below. FileDetail operations use that page's current loaded file. Workspace operations use explicit paths when the path is part of the operation, such as opening or creating a file. The IDE checks permissions and the current file version. `?` denotes optional arguments.

| Tool | Parameters | View / business target |
| --- | --- | --- |
| search_files_by_pattern | pattern, cwd? | Workspace |
| search_files_by_content | pattern, include?, cwd? | Workspace |
| multi_open_file | filePaths, offset?, limit? | Workspace |
| multi_close_file | filePaths | Workspace |
| multi_open_dirs | dirPaths | Workspace |
| multi_close_dirs | dirPaths | Workspace |
| add_folder_to_workspace | folderPath | Workspace |
| remove_folder_from_workspace | folderPath | Workspace |
| refresh_workspace | none | Workspace |
| close_file_detail | none | FileDetail / its currently loaded file |
| close_search_view | none | Current SearchResult |
| write_file | content | FileDetail / its currently loaded file |
| edit_file | oldString, newString, replaceAll? | FileDetail / its currently loaded file |
| create_file | filePath, content | Workspace |
| delete_file | none | FileDetail / its currently loaded file |
| rename_file | newPath | FileDetail / its currently loaded source file and current destination root |
| batch_edit | edits: array of {filePath,oldString,newString} | Workspace / current loaded records captured at invocation |
| lsp_hover | line, character | FileDetail / its currently loaded file |
| lsp_goto_definition | line, character | FileDetail / its currently loaded file |
| lsp_find_references | line, character | FileDetail / its currently loaded file |
| lsp_get_diagnostics | none | FileDetail / its currently loaded file |
| lsp_document_symbol | none | FileDetail / its currently loaded file |
| lsp_incoming_calls | line, character | FileDetail / its currently loaded file |
| lsp_outgoing_calls | line, character | FileDetail / its currently loaded file |
| read_loaded_diagnostics | none | Optional read-only diagnostics slice; status and View hint only |
| create_file_if_absent | relativePath, content | Optional WorkspaceCreate slice, existing parent only; app-owned exclusive create |

Search matches, LSP values and batch details appear in Views. Tool receipts can point to the actual FileDetail, Workspace after delete or close, and Workspace with a warning after a projection failure. `batch_edit` is enabled when files are loaded. Each successful search creates a SearchResult incarnation. Renaming an open file preserves its View ID and mount. The IDE checks stale file records, conflicting workspace commits and late language responses through the operation's current View.

Opening FileDetails and the first SearchResult uses the complete local projection capacity. A reversible opening that exceeds it reports `OBSERVATION_CAPACITY` and keeps the accepted pages. Close an open View or reduce the displayed file range before retrying. The IDE saves active files and records recent access after local preparation. Session restoration admits saved files in order when their complete projection exceeds capacity and reports `RESTORED_FILE_CAPACITY`.

`create_file` reports the completed disk write and whether its FileDetail opened through `diskCommitted` and `viewOpened`. A retained write with a failed projection carries a bounded warning. When replacing SearchResult exceeds capacity after unmounting the previous result, the IDE reports the rejection and prepares the previous result with a new mount. Calls targeting the detached incarnation are revoked.

## Behavior corrections

- Missing/unreadable/unsupported/incomplete directories or searches are failures, not successful empty results. Failed search preserves the previous panel and returns a bounded sample with `complete:false`.
- Ranges work: offset is zero-based, default 0; limit is 1–2000, default 2000. Display/LSP result coordinates are one-based. LSP receives the complete observed text rather than the displayed page. Oversized lines/pages are rejected whole.
- Counts distinguish opened/reloaded/duplicate/unchanged. Directory-boundary membership prevents `project` removal from affecting `project-sibling`.
- Multi-open prepares all requested records before one commit. A missing/unreadable file rejects the preparation and preserves the previous loaded records; it does not publish a successful subset. Batch disk edits retain their separate per-item partial/unknown semantics.
- The IDE file adapter records file/root/parent identity and content version. Same-content inode replacement, symlinks, hardlinks and external changes invalidate writes. Cooperative locks and final checks do not provide OS-wide CAS against noncooperating writers.
- Existing-file writes require a currently loaded file record. Use `create_file` for exclusive creation; the public FileDetail `write_file` cannot create an absent target. Full create/rename may create up to 32 parent levels and reports subsequent failure as partial; the optional slice never creates parents. Rename neither overwrites a target nor silently crosses devices.
- Batch validates all shapes first, executes sequentially, chains duplicate paths through its own new versions, and stops on failure/unknown. Per-item outcomes are succeeded/failed/unknown/not-run. It cannot absorb an unrelated workspace commit as its own.
- A disk commit followed by display/history failure retains known disk success with warning. Unknown writes are never automatically replayed.
- LSP uses didOpen/didChange/didClose and monotonically increasing document versions. Retired roots/files/Views reject late responses. Unversioned pushes are not relabelled current. TypeScript diagnostics use standard native LSP pull requests. Other valid diagnostics without severity preserve the legacy default 1. Validation precedes panel updates.

## Runtime and application responsibilities

The Runtime routes an authorized call to the selected live App, View and Tool binding, then awaits the handler. It does not validate the meaning of an IDE path, file version, language result or completed write. The IDE owns those checks and awaits its disk calls before reporting success.

A handler returns `{ success: true, data }` for a known success. A handler that returns `{ success: false, error, data? }` produces a failed receipt with the IDE's recovery message and any available data. The IDE keeps its internal resource outcomes and per-item batch results for recovery. Inspect the current Views and the reported disk facts before attempting another write.

`createTUIApp` advertises managed app lifecycle support by default. This IDE registers `useAppLifecycle({ stop, close })` because it owns file, search and LSP work. Cleanup reports carry `state` and `issues`, without callback counts or a `verifiedReleased` claim. IDE cleanup still awaits its actual resources and reports failures. Runtime resource release and App callback completion are separate facts.

## Capacity and process support

| Resource | Engineering limit |
| --- | --- |
| App state | 16 saved roots total, including unavailable restored roots; 64 loaded files, 512 expanded directories; input arrays 64; paths 4096 UTF8 bytes |
| Files/display | Single-link regular UTF8 file ≤4 MiB; page ≤256 KiB; tree ≤10000 entries/200 KiB; complete FileDetail ≤512 KiB |
| LSP | 8 starting/live clients; 64 documents/client; 4 actual pending queries/App; query 30s, initialize 45s |
| DTO | 256 KiB, depth24, nodes5000; no successful truncation |
| Search | One dedicated Worker/App; pattern/include ≤4096 bytes; 10000 entries/candidates; 64 MiB files; 500 results; actual Worker deadline 5s |
| Persistence | 256 KiB history/session JSON; 10 recent entries/root; existing managed session limits unchanged |

Input limits intersect Runtime B1 (128 KiB captured input, 512 KiB wire and structural limits). A 4 MiB readable file does not imply a 4 MiB accepted tool write. Timed-out actual requests retain their ownership and concurrency slots until settlement.

Observation limits also apply: the existing Core accepts at most 256 KiB and 256 bindings per observation. Select the View needed for the next call; traverse a larger workspace with finite selections instead of requesting every loaded file in one observation. The acceptance workload uses four business Views per selection, verifies each complete retained content value, and times the entire 64-file traversal against the unchanged 3000 ms budget. Four Views is a measurement workload, not a guarantee that arbitrary maximum-sized Views fit together.

Verified healthy LSP cleanup is scoped to the qualified darwin-arm64 TypeScript 7.0.2 native profile, built from the pinned same-version source plus the temporary upstream PR #64894 backport. The executable and provenance are packaged with this App; no PATH fallback selects an unrelated tsserver. Shutdown requires code 0, no signal, child close and an empty owned group. Custom servers, other platforms and unqualified profiles cannot certify healthy cleanup. An empty original group is not proof that arbitrary daemonized descendants exited.

The client negotiates UTF-16. TypeScript diagnostics use standard `textDocument/diagnostic` full reports, without previousResultId; missing capability or invalid/oversized reports fail explicitly. Other languages retain versioned push diagnostics. Native file watching depends on the OS allowing FSEvents; the integration qualification uses synthetic directories with normal local permissions. Restricted sandbox execution is recorded separately, not called a successful watcher test.

A group probe denied with `EPERM` retains ownership and continues the existing bounded wait; only `ESRCH` proves absence. Persistent denial and failed signals remain cleanup failures. Failure logs contain only bounded phase/resource codes (`LSP_CLOSE_FAILURE` / `IDE_CLOSE_FAILURE`), without document contents or arbitrary server messages. Queued history work cancelled before I/O is a normal stop; uncertain handle/lock cleanup remains sticky and blocks healthy release.

## Restoration

Managed state owns `workspaceFolders`, `activeFiles` and `expandedDirs` under the session key. Recent history is a separate shared file with version 1 and `workspaces`. Reading validates the current fields, ignores other top-level metadata, and preserves the original file. An ordinary history write saves the current fields.

The explicitly configured `projectPath` must be a usable directory. A separately restored root that now fails with `ENOENT` or `ENOTDIR` is listed under **Unavailable folders** while other valid roots remain usable. Its normalized absolute path stays in the existing `workspaceFolders` value across restarts and still counts toward the 16-root limit. Unavailable roots are excluded from LSP, search and file access. Permission errors, invalid saved data, identity changes and uncertain cleanup remain initialization failures; this recovery rule does not hide failures while reading the workspace tree.

The IDE does not recreate missing directories. Restore a folder at its listed path and call `add_folder_to_workspace` to reconnect it, or call `remove_folder_from_workspace` to delete that saved entry. Both actions remain available when every saved root is unavailable. Reconnecting a saved path, or an alias of an already connected canonical root, does not consume another slot. Existing active-file and expanded-directory recovery is unchanged: only files that can be loaded under valid roots reopen; inaccessible files produce the existing warning, and expanded paths outside valid roots are omitted. Reconnecting a root does not automatically reopen its former files.

Corrupt history is left on disk and the operation reports the error. Partial initialization releases unconfirmed bindings before managed flush.

## Replace an installed IDE

1. Stop issuing calls to the current App instance. Close the App and await its actual resource report. Record failed/unknown disk outcomes for inspection.
2. Install the package version you want through its default entry and create fresh observations/bindings; do not reuse old IDs.
3. Inspect the files you edited, renamed or deleted before deciding whether to retry any write with an unknown outcome.

The package's default factory is the only current app entry. Updating installed packages does not publish a release; older installed artifacts do not gain new behavior automatically.

## Reproduce

Build Runtime → SDK → IDE in an isolated checkout; run the existing package suites and `tests/scoped-ide.e2e.mjs`, `scoped-ide-edges.mjs`, `scoped-ide-capacity.mjs`, `scoped-lsp.e2e.mjs`, `scoped-lsp-capacity.mjs`, `scoped-ide-performance.mjs`, each with a new JSON output path. Full workflow/performance accept `AOTUI_IDE_CONSUMER` for a clean installed consumer. Capacity tests distinguish direct business-owner checks, controlled protocol faults and actual processes; the custom LSP capacity server deliberately remains unverified for healthy cleanup. Run performance separately from other heavy tests/installations. Use explicit temporary data; tests never redirect HOME. Performance numbers and exact artifact support are recorded in the delivery's frozen profile and D6 evidence, not inferred from version ranges.

## Local terminal from exact installed packages

Use the delivery's package manifests and lockfile to install a matching Runtime, SDK and IDE into an independent consumer. [Runtime README](../../runtime/README.md)

Run the example shipped with the installed IDE from that consumer directory:

```sh
node node_modules/@agentina/aotui-ide/examples/local-scoped-ide.mjs \
  --project /absolute/project --data /absolute/app-data --session my-project
```

Both project and data paths are explicit. The session defaults to a stable digest of the real project directory. The example runs with the local operator's permissions and never rebuilds the repository's shared dist. It prints the actual Runtime and IDE module URLs at startup, including normal package-manager resolution.

Send JSON lines with `op`: `views`, `observe`, `adopt`, `invoke`, `release` or `exit`. `observe` prepares an observation; explicitly `adopt` its ID before invoking a Tool from it. Adoption replaces the previous calling qualification. `views` lists current pages through the read-only preview. Find the Tool in the observation and supply the receiving page in `input.view_id`.

An `invoke` command contains `invocationId`, `observationId`, `toolId` and `input`. If the ID is omitted the example generates one. To read the same completed receipt again, resend the same complete request with the same ID: Core checks its fingerprint and independently authorizes receipt reading without entering the handler again. There is no standalone `receipt` command. Do not turn an unknown outcome into a new write attempt. Inspect the returned receipt's succeeded/rejected/failed/unknown outcome.

Release observations when finished. Each observation includes all open Views. Observe and adopt again after the receiving View is replaced. Receipt retention and invocation identity belong to the original App instance. The data directory contains managed state/history; it is separate from installed packages. Different session keys isolate managed state, while recent history uses the selected cooperative shared history resource.

EOF, `exit`, SIGINT and SIGTERM stop admission and await the actual Runtime close report. Accepted startup work is joined so its lifecycle callbacks can be installed and released. The example never starts another initialization attempt after stop. Input errors do not discard subsequent commands. Initialization failure is recognized only from the IDE Root, retains its existing error, and is followed by real cleanup; arbitrary Workspace text cannot impersonate startup failure. App cleanup failure and actual Runtime resource release remain distinct, and either unsuccessful close or unreleased resources produces a nonzero exit status.

Run `tests/local-scoped-ide.e2e.mjs <facts.json>` with `AOTUI_IDE_CONSUMER` pointing at the normal installed consumer. The existing test launches this exact packaged entry, observes/adopts, performs real file writes and receipt replay, verifies current Views, exercises startup/stop/restoration and awaits cleanup. Use only temporary project/data fixtures; this test does not qualify unrelated platforms or language servers.
