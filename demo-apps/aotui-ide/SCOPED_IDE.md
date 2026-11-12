# AOTUI IDE package integration

The package has one current entry: its default managed `TUIAppFactory`, created with `createTUIApp` and backed by `ScopedIDEApp`. It has one business owner per App and uses instance-bound Runtime interaction, committed snapshots and managed app state. Normal Host startup uses standard AppRegistry installation and the generic Semantic Source. See the [Host integration contract](../../runtime/docs/semantic-host-integration.zh-CN.md).

The current authoring contract is SDK 0.8.0-srt.1 with Runtime 7.0.0-srt.1. `createTUIApp` supplies `toolAuthoringProtocol: 'view-type-tools-v4'`; Runtime rejects a factory without that marker or with an older value. The IDE declares ordinary Tool inputs once with TypeBox 1.4.3 and registers them at App scope. This is a breaking replacement for the old ordinary `useViewTypeTool(name, options, handler, config?)` and per-View `target` routing. See the [public Tool author guide](../../sdk/docs/view-type-tools.md) for a runnable authoring example and [migration steps](../../sdk/docs/migration.md).

## Standard installation and explicit custom hosts

Install Runtime, SDK and IDE packages from a compatible delivery. Published packages with identical version numbers do not prove support for the current contracts.

```ts
import { createRuntime } from '@aotui/runtime';

const runtime = createRuntime();
const desktopId = await runtime.createDesktop('my-ide');
const appModulePath = import.meta.resolve('@agentina/aotui-ide');
const appId = await runtime.installDynamicWorkerApp(desktopId, appModulePath, {
    appId: 'my-ide',
    interactionModes: ['view-type-parameters-v1'],
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

The Host supports `view-type-parameters-v1` for both ordinary and Ref parameters. Omitting `interactionModes` enables this mode; `[]` disables execution. The matching Host/Worker capability is `view-tool-parameters-invoke/v4`. Retired modes and execution categories are rejected. The optional diagnostics and WorkspaceCreate tools use the same current mode. A trusted Controller can set the instance's projection, execution authorization and receipt authorization policy. App configuration is not an OS filesystem sandbox.

The normal Host supplies App identity, Desktop identity, project path and managed persistence through AppContext. When omitted, the IDE derives its session key from Desktop and App identity, and stores history under `AOTUI_DATA_DIR/ide-sessions/<sessionKey>/history.json`. Explicit overrides remain available: session keys must be 1–128 ASCII letters/digits/underscore/dot/hyphen and history paths must be absolute. The current package default does not open the legacy home LowDB. Give concurrent independent Apps distinct session keys; identical keys are not a shared-write protocol. Recent history uses a cooperative lock/CAS and reports conflicts/warnings without invisible retries.

## All tools and business targets

`?` means optional. Single-file write/edit/delete/rename belong to FileDetail; creating a file remains a Workspace action. The IDE defines each ordinary Tool once and registers it through App-level `AppTools`. All open FileDetail Views share that same Tool name, Schema and handler. The explicit `filePath`, `oldPath`, `newPath` or `file_path` values are application parameters; `IDESession` checks them when the handler runs against the currently loaded record. Runtime does not add an implicit file target. Handler defaults are not silently inserted by Schema validation. Business permissions and failure effects are checked independently of Tool metadata. Filesystem searches and LSP queries put result data in their Views and return concise `ToolResult` receipts. They do not require an entity Hook, entity type/ID/version tuple or top-level `refId`.

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
| close_file_detail | view_id | FileDetail / its currently loaded file |
| close_search_view | view_id | Current SearchResult |
| write_file | filePath, content | FileDetail / its currently loaded file |
| edit_file | filePath, oldString, newString, replaceAll? | FileDetail / its currently loaded file |
| create_file | filePath, content | Workspace |
| delete_file | filePath | FileDetail / its currently loaded file |
| rename_file | oldPath, newPath | FileDetail / its currently loaded source file and current destination root |
| batch_edit | edits: array of {filePath,oldString,newString} | Workspace / current loaded records captured at invocation |
| lsp_hover | file_path, line, character | FileDetail / its currently loaded file |
| lsp_goto_definition | file_path, line, character | FileDetail / its currently loaded file |
| lsp_find_references | file_path, line, character | FileDetail / its currently loaded file |
| lsp_get_diagnostics | file_path | FileDetail / its currently loaded file |
| lsp_document_symbol | file_path | FileDetail / its currently loaded file |
| lsp_incoming_calls | file_path, line, character | FileDetail / its currently loaded file |
| lsp_outgoing_calls | file_path, line, character | FileDetail / its currently loaded file |
| read_loaded_diagnostics | filePath | Optional read-only diagnostics slice; status and View hint only |
| create_file_if_absent | relativePath, content | Optional WorkspaceCreate slice, existing parent only; app-owned exclusive create |

File mutation tools use the App's current FileDetail record. `filePath`/`oldPath` identify the requested business file, and the IDE verifies the loaded record before acting. LSP uses `file_path`; close uses `view_id`. No generated selector is added. Search matches, LSP values and batch details appear only in their Views; successful Tool results return receipts rather than duplicate result collections. A receipt uses the actual FileDetail ID for an updated/open file, Workspace after delete or close, and Workspace plus the application's warning if View synchronization failed. No file Tool is exposed before a file is open; Workspace `batch_edit` is enabled only while files are loaded. FileDetail LSP queries refuse another file's path. A successful search creates a new SearchResult incarnation. Renaming an open file preserves its View ID and instance. The IDE captures the relevant workspace version or loaded file record when the handler starts. Its own checks reject real file/root replacement, conflicting workspace commits and late language responses. Updating another language panel does not invalidate an otherwise valid query.

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

A handler returns `{ success: true, data }` for a known success. A failed handler returns `{ success: false, error, effects? }`: the IDE declares `effects: 'none'` or `effects: 'partial'` only when it knows those facts. Leaving `effects` out preserves an unknown outcome. The Runtime records the application's declaration; it does not turn an uncertain write into a safe retry.

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

## Restoration and explicit legacy import

Managed state owns `workspaceFolders`, `activeFiles`, `expandedDirs` under the session key. Recent history is a separate shared business resource. `ideLegacyImportPath` selects an absolute legacy LowDB source, read and hashed without modification. Existing target history and existing managed workspace state win. Legacy recent files are not invented active files.

The explicitly configured `projectPath` must be a usable directory. A separately restored root that now fails with `ENOENT` or `ENOTDIR` is listed under **Unavailable folders** while other valid roots remain usable. Its normalized absolute path stays in the existing `workspaceFolders` value across restarts and still counts toward the 16-root limit. Unavailable roots are excluded from LSP, search and file access. Permission errors, invalid saved data, identity changes and uncertain cleanup remain initialization failures; this recovery rule does not hide failures while reading the workspace tree.

The IDE does not recreate missing directories. Restore a folder at its listed path and call `add_folder_to_workspace` to reconnect it, or call `remove_folder_from_workspace` to delete that saved entry. Both actions remain available when every saved root is unavailable. Reconnecting a saved path, or an alias of an already connected canonical root, does not consume another slot. Existing active-file and expanded-directory recovery is unchanged: only files that can be loaded under valid roots reopen; inaccessible files produce the existing warning, and expanded paths outside valid roots are omitted. Reconnecting a root does not automatically reopen its former files.

Import writes a `history` marker, prepares/saves the managed session, verifies exact flush addresses/revisions, then marks `completed`. The IDE stays unavailable until completion. A new App can resume a failed import using the same source/target; changed source digest conflicts. Corrupt/unknown data is not replaced with defaults. Partial initialization releases unconfirmed bindings before managed flush can deadlock.

## Replace an installed IDE

1. Stop issuing calls to the current App instance. Close the App and await its actual resource report. Record failed/unknown disk outcomes for inspection.
2. Install the package version you want through its default entry and create fresh observations/bindings; do not reuse old IDs.
3. Check actual edited/renamed/deleted files. Replacing an App version does not undo disk effects or authorize replay of an unknown write. A configured legacy data import remains separate from the current app entry.

The package's default factory is the only current app entry. Updating installed packages does not publish a release; older installed artifacts do not gain new behavior automatically.

## Reproduce

Build Runtime → SDK → IDE in an isolated checkout; run the existing package suites and `tests/scoped-ide.e2e.mjs`, `scoped-ide-edges.mjs`, `scoped-ide-capacity.mjs`, `scoped-lsp.e2e.mjs`, `scoped-lsp-capacity.mjs`, `scoped-ide-performance.mjs`, each with a new JSON output path. Full workflow/performance accept `AOTUI_IDE_CONSUMER` for a clean installed consumer. Capacity tests distinguish direct business-owner checks, controlled protocol faults and actual processes; the custom LSP capacity server deliberately remains unverified for healthy cleanup. Run performance separately from other heavy tests/installations. Use explicit temporary data; tests never redirect HOME. Performance numbers and exact artifact support are recorded in the delivery's frozen profile and D6 evidence, not inferred from version ranges.

## Local terminal from exact installed packages

Install a matching Runtime/SDK/IDE delivery into a normal consumer first; versions alone do not prove artifact identity. Use the delivery's actual package manifests and lockfile, as described by the [distribution contract](../../runtime/docs/sdk-runtime-distribution.md). There is no special generated terminal environment or alternate app route. The old repository `scripts/scoped-ide.mjs` prepare/run/verify wrapper has been removed.

Run the example shipped with the installed IDE from that consumer directory:

```sh
node node_modules/@agentina/aotui-ide/examples/local-scoped-ide.mjs \
  --project /absolute/project --data /absolute/app-data --session my-project
```

Both project and data paths are explicit. The session defaults to a stable digest of the real project directory. The example runs with the local operator's permissions and never rebuilds the repository's shared dist. It prints the actual Runtime and IDE module URLs at startup, including normal package-manager resolution.

Send JSON lines with `op`: `views`, `observe`, `adopt`, `invoke`, `release` or `exit`. `observe` prepares an observation; explicitly `adopt` its ID before selecting one of its bindings. Adoption replaces the previous calling qualification. `views` lists current pages through the read-only preview. Tool selection is shared by ViewType; file paths remain explicit business parameters checked by the IDE, with no per-file execution target.

An `invoke` command contains `invocationId`, `observationId`, `bindingId` and `input`. If the ID is omitted the example generates one. To read the same completed receipt again, resend the same complete request with the same ID: Core checks its fingerprint and independently authorizes receipt reading without entering the handler again. There is no standalone `receipt` command. Do not turn an unknown outcome into a new write attempt. Inspect the returned receipt's succeeded/rejected/failed/unknown outcome.

Release observations when finished. Select only the Views needed within existing observation limits, and observe/adopt again after a binding is replaced. Receipt retention and invocation identity belong to the original App instance. The data directory contains managed state/history; it is separate from installed packages. Different session keys isolate managed state, while recent history uses the selected cooperative shared history resource.

EOF, `exit`, SIGINT and SIGTERM stop admission and await the actual Runtime close report. Accepted startup work is joined so its lifecycle callbacks can be installed and released. The example never starts another initialization attempt after stop. Input errors do not discard subsequent commands. Initialization failure is recognized only from the IDE Root, retains its existing error, and is followed by real cleanup; arbitrary Workspace text cannot impersonate startup failure. App cleanup failure and actual Runtime resource release remain distinct, and either unsuccessful close or unreleased resources produces a nonzero exit status.

Run `tests/local-scoped-ide.e2e.mjs <facts.json>` with `AOTUI_IDE_CONSUMER` pointing at the normal installed consumer. The existing test launches this exact packaged entry, observes/adopts, performs real file writes and receipt replay, verifies current Views, exercises startup/stop/restoration and awaits cleanup. Use only temporary project/data fixtures; this test does not qualify unrelated platforms or language servers.
