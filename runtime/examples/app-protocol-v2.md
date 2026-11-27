# External App protocol v2

The trusted Host registers a fixed command and gives the Agent an installation ID. Runtime starts the command when the installation opens. The App uses UTF-8 JSON Lines on standard input and standard output and puts its own logs on standard error. The local backend launches the exact argument vector without a shell. It runs trusted code with the Host process's local permissions.

```js
import { createRuntime } from '@aotui/runtime';

const runtime = createRuntime();
const desktop = await runtime.createDesktop();
await desktop.registerPendingApp({
  installationId: 'python_files',
  name: 'delivered_files',
  command: ['python3', '-u', '/absolute/path to/runtime/examples/python-files.py'],
  config: { folder: '/absolute/path to/your working directory' },
});
const app = await desktop.openApp('python_files');
// Use app.observe() and desktop.adoptTurn() as for a TypeScript App.
await runtime.beginClose().completion;
```

The Python file App lists direct regular files from `config.folder` when it publishes. Use the exact name shown in the directory with `open_file`. It takes a string and checks the current directory at execution, so the same Tool can open a file created after the last observation. The example skips subdirectories, symbolic links and the reserved `writes.jsonl` log. Files are read and written as UTF-8. A missing file or an invalid file selection returns `FILE_UNAVAILABLE`.

Use `A.txt` to try the optional `reload_a` and `disable_a` demonstration. These Tools reread the A page or revoke its edit binding and restrict its content Ref.

## Handshake and message format

Runtime sends `{"type":"hello","protocol":"aotui-app","major":2,"capabilities":["attention"],"requires":[]}`. The App replies with the same shape and its supported capabilities. The lists may be omitted when empty. An unknown offered capability can be ignored. A capability named in `requires` must be supported by the other party. The common capabilities are passed in `initialize`. A wrong identity or major fails with `PROTOCOL_UNSUPPORTED`. An App requirement that Runtime cannot meet fails with `CAPABILITY_REQUIRED`. This handshake is separate from the Host protocol on `aotui-stdio`.

Runtime sends one object per line. The App writes and flushes one object per line. A final complete object at end of stream can also be read without a newline. The local transport limits incoming lines to 8 MiB before decoding. The host validates the content of each frame and tool receipt against their own limits. Use an `extensions` object for optional data that older peers can omit or ignore. Send additional feature messages only when both parties negotiated the feature.

## Requests and responses

Each subsequent request has a string `id`. The App echoes that ID in `{"type":"reply","id":"…","status":"…"}`. Use the same original request ID through actual completion. There is at most one business operation in flight. While waiting for a candidate result, keep consuming input: handle STOP immediately, check observe against the old committed healthy stamp, and reject another business operation rather than executing it concurrently. CLOSE joins the actual operation before cleanup.

| Request `type` | Fields or result |
| --- | --- |
| `initialize` | Runtime passes `appId`, `instanceId`, `desktopId`, the registered `name`, optional JSON `config` (absence is preserved), boolean `toolsEnabled`, and negotiated `capabilities`. Reply `ready`, or `failed` with an `issue` containing `code`, `message` and an optional `path`. |
| `open` | Publish the complete original OPEN sample with `requestId` equal to the OPEN id, then reply `done` with its exact accepted stamp, or `failed` with an `issue`. A healthy empty frame is valid. |
| `observe` | If the request’s optional `known` equals the current healthy committed local stamp, send `{type:"projectionCurrent",id,publication}` with that exact stamp. Otherwise publish a complete sample with the original `requestId`, then reply `done` with its exact accepted stamp. A generic done without that sample cannot confirm an observation. |
| `invoke` | Runtime passes `appId`, `instanceId`, `tool` (`viewType`, `name`), `receiver` (`viewId`, `viewInstanceId`, `activationId`), the resolved `input` object and `localRefs`. Reply with `status: "tool"`, the App's own `appId` and `instanceId`, and a `terminal`. |
| `closeView` | Runtime passes `appId`, `instanceId`, `viewId`, `viewInstanceId`, `closeActivationId`. Reply with the same terminal format as `invoke`. |
| `stop`, `close` | Stop new work and finish App-owned cleanup. Reply `done` with `cleanup: {state, issues}`. Normal states are `stopped` for `stop` and `completed` for `close`, with empty `issues`. To report a lifecycle failure use `failed` and `APP_STOP_FAILED` or `APP_CLEANUP_FAILED` in `issues`. The local process may exit after the close reply is flushed. |

Each local Ref carries `param`, `viewId`, `viewInstanceId`, `refId`, `since` and, for a direct array element, `index`. Check that the request targets the current App instance and receiver. Check the current tool activation, the publishing mounts and each Ref's current scope and its relevant continuity lane's exact since epoch. Read only the final `input` values and check them against the current business parameter schema before entering the handler. The values come from the original observation. A Ref change after the observation can revoke access without substituting a new value.

The terminal has `phase: "not-entered"` with a failed `result` when no handler ran, `phase: "entered-returned"` with the returned `result`, or `phase: "finished-unknown"` if the App cannot confirm a result. A result is `{success:true}` with optional JSON object `data`, or `{success:false,error:{code,message}}` with optional JSON object `context` or `data`. After dispatch, Runtime preserves the original call if a Host wait times out. If the complete receipt channel ends without a valid terminal, the outcome is unknown. Runtime retains the execution slot until actual exit and pipe drain are confirmed.

## Complete projections

The App sends `{"type":"publish","id":"frame-1","mode":"authoritative","frame":{…}}` after local commit, without waiting for success ACK. The first actually accepted complete publication includes a top-level `viewTypes` array (for example, `[{"name":"file","multiplicity":"multiple"}]`). It is the minimal sealed declaration table, including types without active Tools. An empty table is valid. The Receiver applies the existing 1000 declaration count and effective metadata byte budget; unknown types, duplicate names, inconsistent multiplicity, or two mounts of a single type are rejected. Failed acceptance does not seal the table. Retry a corrected declaration only after an explicit rejection, never on an absent or timed-out ACK. Later accepted frames omit the declaration table. The frame contains positive safe integers `producerSeq`, `sourceEpoch`, `healthySince` and three arrays.

- `views` entries have `id`, `type`, `name`, `region` (`static` or `dynamic`), raw Markdown `body`, `viewInstanceId`, and `tools`. Each tool binding is `{name, activationId}`. Include `closeActivationId` when the page has an enabled close action.
- `refs` entries have `viewId`, `viewInstanceId`, `id`, `scope`, `continuity`, `valueSchema`, and JSON `value`. A nominal type can be supplied as `refType`. Use `array: true` for an ArrayRef. Ref IDs match `[A-Za-z_][A-Za-z0-9_]*`. Runtime translates the structured fields to its internal keys.
- `tools` entries have `viewType`, `name`, `multiplicity` (`single` or `multiple`), `description` and JSON `inputSchema`. List only declarations with at least one enabled View binding. All open pages of one type share the same declaration. Use the supported JSON Schema 2020-12 subset for parameter and Ref schemas.

Keep each page's `viewInstanceId` while it is open and give a new mount a fresh identity, even when reusing the same `viewId`. Each active binding has an `activationId` unique within the execution. Give it a new identity after disabling and re-enabling the tool. View IDs and mount/activation tokens belong to this App execution.

A publication stamp is `{appId,instanceId,producerSeq,sourceEpoch}`. The Producer owns the epochs and three Ref continuity lanes `[selfSince,sameAppSince,publicSince]`; zero means unavailable. Retain the lane's starting epoch while continuously available, reset it to the new epoch when restored. On local authoritative failure, send `projectionFailed` with the latest successful sourceEpoch, a new producerSeq and issue. Only a subsequent authoritative success can restore local health. Mounts use `m:<positive integer>`, Tool and close activations share `a:<positive integer>`, each monotonically allocated within the instance.

Use `mode:"candidate"` for a tentative change: wait for the matching `publishResult` with `status:"accepted"` and its exact publication stamp before installing the candidate. `status:"rejected"` preserves the previous committed state. A rejected authoritative frame degrades the Receiver, independently of the Producer's own successful local commit. Keep a confirmed business write even if its presentation fails. The reference App processes interleaved STOP and request guards while waiting for the matching candidate acknowledgement. STOP seals the candidate against local installation and CLOSE waits for actual operation completion. An interleaved observe can confirm only the old committed healthy stamp, not an uninstalled candidate. The Receiver independently rejects or accepts publication; a successful authoritative commit never waits for a success ACK, and explicit rejection feedback does not undo its business state.

With the optional `attention` capability, the App can send `{"type":"attention"}` once for a meaningful background event. The Host decides whether to observe. Regular publication does not itself request a new model turn.

The [Python reference App](python-files.py) and [compatibility vectors](app-protocol-v2-vectors.json) can be saved independently of the Runtime and replayed unchanged.
