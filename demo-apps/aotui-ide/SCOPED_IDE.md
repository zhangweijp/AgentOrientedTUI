# Semantic IDE: default integration

The package default, `SystemIDEApp`, `ideEntryForRoute()` and generated aoapp use the `scoped` implementation. It has one business owner per App and reuses Runtime Scope, snapshots, View registry and managed session. Normal Host startup uses standard AppRegistry installation and the generic Semantic Source. No IDE-specific adapter or development environment variable is required. See the [Host integration contract](../../runtime/docs/semantic-host-integration.zh-CN.md).

## Standard installation and explicit custom hosts

Install Runtime, SDK and IDE tarballs from the same delivery. Published packages with identical version numbers do not prove support for the new capabilities.

```ts
import { ideEntryForRoute } from '@agentina/aotui-ide';
const appModulePath = ideEntryForRoute('scoped').href;
const config = {
    ideToolRoute: 'scoped',
    projectPath: '/absolute/project',
    ideSessionKey: 'my-project',
    ideHistoryPath: '/absolute/app-data/ide-history.json',
    AOTUI_DATA_DIR: '/absolute/app-data',
    enableDiagnosticsRead: true,
    enableWorkspaceCreate: true,
};
```

Use existing Runtime/WorkerSandbox options: `snapshotShadow: true`, `experimentalInteractionModes: ['ordinary-v2','ordinary-v1','create-if-absent-v1']`. A Host using the diagnostic slice also needs `experimentalReadOnlyViewTools: true`. Supply the Controller's actual Scope projection, authorization and receipt policy; test allow-all policies are not production authorization. App configuration is not an OS filesystem sandbox.

The normal Host supplies App identity, Desktop identity, project path and managed persistence through AppContext. When omitted, the IDE derives its session key from Desktop and App identity, and stores history under `AOTUI_DATA_DIR/ide-sessions/<sessionKey>/history.json`. Explicit overrides remain available: session keys must be 1–128 ASCII letters/digits/underscore/dot/hyphen and history paths must be absolute. Entry and route config must agree. The Semantic entry does not open the legacy home LowDB. Give concurrent independent Apps distinct session keys; identical keys are not a shared-write protocol. Recent history uses a cooperative lock/CAS and reports conflicts/warnings without invisible retries.

## All tools and business targets

`?` means optional. Single-file write/edit/delete/rename now belong to FileDetail and omit their target path from the public arguments; creating a file remains a Workspace operation. Handler defaults are not silently inserted by schema validation. The first 24 tools reuse the three-argument `useViewTypeTool` with `isMutating: true` and ordinary-v2. Filesystem searches and LSP queries update their result Views. Their handlers return an ordinary `OperationResult`; they do not require an entity Hook, entity type/ID/version tuple or top-level `refId`.

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
| write_file | content | FileDetail / its currently loaded file |
| edit_file | oldString, newString, replaceAll? | FileDetail / its currently loaded file |
| create_file | filePath, content | Workspace |
| delete_file | none | FileDetail / its currently loaded file |
| rename_file | newPath | FileDetail / its currently loaded source file and current destination root |
| batch_edit | edits: array of {filePath,oldString,newString} | Workspace / current loaded records captured at invocation |
| lsp_hover | file_path, line, character | FileDetail / its currently loaded file |
| lsp_goto_definition | file_path, line, character | FileDetail / its currently loaded file |
| lsp_find_references | file_path, line, character | FileDetail / its currently loaded file |
| lsp_get_diagnostics | file_path | FileDetail / its currently loaded file |
| lsp_document_symbol | file_path | FileDetail / its currently loaded file |
| lsp_incoming_calls | file_path, line, character | FileDetail / its currently loaded file |
| lsp_outgoing_calls | file_path, line, character | FileDetail / its currently loaded file |
| read_loaded_diagnostics | none | Optional ordinary-v1 slice, already loaded state only |
| create_file_if_absent | relativePath, content | Optional create-if-absent-v1 WorkspaceCreate slice, existing parent only |

File mutation tools use their owning FileDetail record. No file mutation tool is exposed before a file is open; Workspace batch_edit is enabled only when files are loaded. FileDetail LSP queries refuse another file's path. A successful search creates a new SearchResult incarnation. Renaming an open file preserves its View ID and instance. The IDE captures the relevant workspace version or loaded file record when the handler starts. Its own checks reject real file/root replacement, conflicting workspace commits and late language responses. Updating another language panel does not invalidate an otherwise valid query.

## Behavior corrections

- Missing/unreadable/unsupported/incomplete directories or searches are failures, not successful empty results. Failed search preserves the previous panel and returns a bounded sample with `complete:false`.
- Ranges work: offset is zero-based, default 0; limit is 1–2000, default 2000. Display/LSP result coordinates are one-based. LSP receives the complete observed text rather than the displayed page. Oversized lines/pages are rejected whole.
- Counts distinguish opened/reloaded/duplicate/unchanged. Directory-boundary membership prevents `project` removal from affecting `project-sibling`.
- Multi-open prepares all requested records before one commit. A missing/unreadable file rejects the preparation and preserves the previous loaded records; it does not publish a successful subset. Batch disk edits retain their separate per-item partial/unknown semantics.
- The IDE file adapter records file/root/parent identity and content version. Same-content inode replacement, symlinks, hardlinks and external changes invalidate writes. Cooperative locks and final checks do not provide OS-wide CAS against noncooperating writers.
- Existing-file writes require a currently loaded file record. Use `create_file` for exclusive creation; the public FileDetail `write_file` cannot create an absent target. Full create/rename may create up to 32 parent levels and reports subsequent failure as partial; the optional slice never creates parents. Rename neither overwrites a target nor silently crosses devices.
- Batch validates all shapes first, executes sequentially, chains duplicate paths through its own new versions, and stops on failure/unknown. Per-item outcomes are succeeded/failed/unknown/not-run. It cannot absorb an unrelated workspace commit as its own.
- A disk commit followed by display/history failure retains known disk success with warning. Unknown writes are never automatically replayed.
- LSP uses didOpen/didChange/didClose and monotonically increasing document versions. Retired roots/files/Views reject late responses. Unversioned pushes are not relabelled current. TypeScript diagnostics use actual synchronous tsserver requests. Other valid diagnostics without severity preserve the legacy default 1. Validation precedes panel updates.

## Runtime and application responsibilities

The Runtime routes an authorized call to the selected live App, View and Tool binding, then awaits the handler. It does not validate the meaning of an IDE path, file version, language result or completed write. The IDE owns those checks and awaits its disk operations before reporting success.

A handler returns `{ success: true, data }` for a known success. A failed handler returns `{ success: false, error, effects? }`: the IDE declares `effects: 'none'` or `effects: 'partial'` only when it knows those facts. Leaving `effects` out preserves an unknown outcome. The Runtime records the application's declaration; it does not turn an uncertain operation into a safe retry.

`experimental_useAppLifecycle` uses the negotiated app-lifecycle-v2 protocol. Callbacks are optional for applications in general; this IDE supplies `stop` and `close` because it owns actual file, search and LSP work. Cleanup reports carry `state` and `issues`, without callback counts or a `verifiedReleased` claim. IDE cleanup still awaits its actual resources and reports failures. Runtime resource release and App callback completion are separate facts.

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

Verified healthy LSP cleanup is scoped to the exercised POSIX profile: typescript-language-server 5.1.3 and TypeScript 5.9.3. Each server has an owned process group; shutdown waits for child close and an empty group. This assumes trusted server/plugin code. Custom servers, other versions/languages and Windows can provide queries, but full cleanup is unverified/failed and prevents healthy Worker reuse. An empty original group is not proof that arbitrary daemonized descendants exited.

A group probe denied with `EPERM` retains ownership and continues the existing bounded wait; only `ESRCH` proves absence. Persistent denial and failed signals remain cleanup failures. Failure logs contain only bounded phase/resource codes (`LSP_CLOSE_FAILURE` / `IDE_CLOSE_FAILURE`), without document contents or arbitrary server messages. Queued history work cancelled before I/O is a normal stop; uncertain handle/lock cleanup remains sticky and blocks healthy release.

## Restoration and explicit legacy import

Managed state owns `workspaceFolders`, `activeFiles`, `expandedDirs` under the session key. Recent history is a separate shared business resource. `ideLegacyImportPath` selects an absolute legacy LowDB source, read and hashed without modification. Existing target history and existing managed workspace state win. Legacy recent files are not invented active files.

The explicitly configured `projectPath` must be a usable directory. A separately restored root that now fails with `ENOENT` or `ENOTDIR` is listed under **Unavailable folders** while other valid roots remain usable. Its normalized absolute path stays in the existing `workspaceFolders` value across restarts and still counts toward the 16-root limit. Unavailable roots are excluded from LSP, search and file operations. Permission errors, invalid saved data, identity changes and uncertain cleanup remain initialization failures; this recovery rule does not hide failures while reading the workspace tree.

The IDE does not recreate missing directories. Restore a folder at its listed path and call `add_folder_to_workspace` to reconnect it, or call `remove_folder_from_workspace` to delete that saved entry. Both actions remain available when every saved root is unavailable. Reconnecting a saved path, or an alias of an already connected canonical root, does not consume another slot. Existing active-file and expanded-directory recovery is unchanged: only files that can be loaded under valid roots reopen; inaccessible files produce the existing warning, and expanded paths outside valid roots are omitted. Reconnecting a root does not automatically reopen its former files.

Import writes a `history` marker, prepares/saves the managed session, verifies exact flush addresses/revisions, then marks `completed`. The IDE stays unavailable until completion. A new App can resume a failed import using the same source/target; changed source digest conflicts. Corrupt/unknown data is not replaced with defaults. Partial initialization releases unconfirmed bindings before managed flush can deadlock.

## Switch and rollback

1. Stop issuing calls to the current Scope. Close the App and await its actual resource report. Record failed/unknown disk outcomes for inspection.
2. Create a new App with `ideEntryForRoute('scoped').href` and the configuration above. Obtain fresh observations/bindings; do not reuse old IDs.
3. Roll back by closing that instance and creating another using `ideEntryForRoute('legacy').href` (explicit historical entry only). For an isolated legacy database, pass `ideLegacyDatabasePath: '/absolute/rollback-data/ide-database.json'`. Omitting it preserves the legacy home behavior.
4. Check actual edited/renamed/deleted files. Route rollback does not undo disk effects, merge the new session into LowDB or authorize unknown replay. The import source remains available for deliberate recovery.

The default router has switched to Semantic. Legacy is retained only pending the project owner's acceptance of the new path, after which it can be removed. This work does not publish packages; old installed artifacts do not gain the new behavior automatically.

## Reproduce

Build Runtime → SDK → IDE in an isolated checkout; run the existing package suites and `tests/scoped-ide.e2e.mjs`, `scoped-ide-edges.mjs`, `scoped-ide-capacity.mjs`, `scoped-lsp.e2e.mjs`, `scoped-lsp-capacity.mjs`, `scoped-ide-performance.mjs`, each with a new JSON output path. Full workflow/performance accept `AOTUI_IDE_CONSUMER` for a clean installed consumer. Capacity tests distinguish direct business-owner checks, controlled protocol faults and actual processes; the custom LSP capacity server deliberately remains unverified for healthy cleanup. Run performance separately from other heavy tests/installations. Use explicit temporary data; tests never redirect HOME. Performance numbers and exact artifact support are recorded in the delivery's frozen profile and D6 evidence, not inferred from version ranges.

## Local terminal from exact installed packages

From the repository root, prepare one generated environment from a delivery containing `artifacts/local-dev.json`, the three tarballs, and the consumer manifest/lock. Read that delivery's decision for its acceptance status; the preparation command checks artifact integrity, not acceptance or a publisher signature.

```sh
node scripts/scoped-ide.mjs prepare /absolute/accepted-delivery
node scripts/scoped-ide.mjs run --project /absolute/project
node scripts/scoped-ide.mjs verify
```

Preparation checks SHA-256 for all five input files, installs with `npm ci --ignore-scripts`, and verifies the lock and installed package identities. Add `--offline` to require a fully cached installation. It uses the same `.tmp/sdk-runtime-current/current` each time, with explicit npm configuration and cache; it does not rebuild the repository's shared `dist`. The terminal executes the example shipped inside the installed IDE package, so changing the working directory cannot silently select old source-linked dependencies. It prints the actual Runtime and IDE module URLs at startup.

`run` is a trusted local stdin Controller with the operator's filesystem/process permissions, all 24 tools and both optional slices enabled. It is not an authenticated network endpoint or an OS sandbox. It uses public Runtime APIs, explicit `scoped` routing, and no model, Agent Driver, home registry or Electron Host. The normal product default also uses Semantic; the terminal remains a separate programmatic consumer.

Each input line is one JSON command. Structured replies start with `AOTUI_IDE `; other dependency logs may also appear on stdout. `ready` includes the initial Root and Workspace observation. Use its real IDs for a call; the following is a template rather than a command with usable IDs:

```json
{"op":"views"}
{"op":"observe","viewIds":["workspace"]}
{"op":"invoke","invocationId":"my-unique-call","observationId":"<observed-id>","bindingId":"<observed-binding>","input":{"filePaths":["/absolute/project/example.ts"]}}
{"op":"receipt","invocationId":"my-unique-call"}
{"op":"release","observationId":"<observed-id>"}
{"op":"exit"}
```

`views` lists selectors, not authority. Match an observation's tool name and its binding target to the View you intend to call. Pass the original tool parameters only. File paths select the IDE's current loaded records; FileDetail queries use that View's current file. An observation grants access to the observed Tool binding, without freezing the application's business data. A live binding can be used for multiple language queries as panels update. A `receipt` reply can contain rejected, failed or unknown outcomes; inspect `receipt.outcome.status`. The terminal does not automatically retry writes. If `invocationId` is omitted it generates one; keep an explicit ID when you need to retrieve a receipt or perform a deliberate identical replay.

Release observations when finished; the default limit remains 8 per Scope. Scope and Observation now use explicit ownership by default, with no fixed 30-second/10-minute expiry. Select only the Views needed for a call within the unchanged 256 KiB/256-binding limits. Observe again when a View or Tool binding is replaced. Receipt content still has a bounded retention period, and invocation deduplication belongs to the original Scope. Closing a Scope never authorizes replay of an unknown write. Older installed deliveries retain their own documented defaults.

Data defaults to `.tmp/sdk-runtime-current/data`, outside the replaceable consumer. `--data /absolute/data` and `--session my-project` override it. The default session is a stable digest of the real project directory; the fixed Desktop ID and explicit history/state paths allow restart restoration. Different session keys isolate managed workspace state; recent history is a separate cooperative shared file under the chosen data directory. Do not place user data in `current`, `preparing`, or `results`.

The IDE's Root View displays `Initialization failed: CODE` when restoration fails. Known application codes are retained; native `ENOENT`, `ENOTDIR`, `EACCES`, `EPERM`, `EIO` and `ELOOP` become `IDE_IO_<code>`, and unknown errors remain `IDE_INITIALIZATION_FAILED`. The terminal observes Root and Workspace during startup and reports that explicit Root failure immediately, then awaits normal shutdown. Workspace file names and content are not interpreted as startup status. Restoration still in progress keeps the existing 15-second readiness deadline.

EOF, `exit`, SIGINT and SIGTERM stop new input and wait for the actual Runtime close report. A failed close callback or incomplete Runtime resource release sets a nonzero exit status. The report keeps these separate: `appCleanup.failedApps` describes callback failure, while `resourcesReleased` reports resources the Runtime actually owns. A failed App is not returned as a healthy reusable Worker; its terminated Worker may still be reported as released. A command parsing error is reported and subsequent input remains available. During initialization, the terminal first joins the already accepted Desktop/install operation so the App can install its lifecycle callbacks; it then closes that actual instance. This uses Runtime's existing request deadlines, not a fixed delay. It never starts another initialization operation after stop is requested. Signals during a normal pending tool call begin Runtime shutdown immediately rather than waiting for that call. Initialization failures remain an `error` event and a nonzero exit status; the actual close report is emitted separately without alteration. There is one operation lock for prepare/run/verify, preventing replacement of a running consumer. After a hard crash, inspect the PID recorded in `.tmp/sdk-runtime-current/.operation.lock` and its descendants before removing that exact stale lock. An interrupted prepare can leave `preparing`; remove only that generated staging directory after confirming no process still owns it, then prepare again. Failure during the final consumer replacement can require preparing again; persisted `data` is separate.

`verify` runs strict public package consumption, the complete IDE workflow, and the installed terminal tests, including real writes/LSP, restoration, queued input, startup signals, and a controlled process-group inspection denial. It writes timestamped JSON evidence under `.tmp/sdk-runtime-current/results` and removes its generated fixture data. It does not substitute for the separately frozen three-round performance or full Runtime regression gates. Preparation and verification preserve `HOME`.
