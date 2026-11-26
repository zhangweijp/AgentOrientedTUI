# External App protocol v1

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

Runtime sends `{"type":"hello","protocol":"aotui-app","major":1,"capabilities":["attention"],"requires":[]}`. The App replies with the same shape and its supported capabilities. The lists may be omitted when empty. An unknown offered capability can be ignored. A capability named in `requires` must be supported by the other party. The common capabilities are passed in `initialize`. A wrong identity or major fails with `PROTOCOL_UNSUPPORTED`. An App requirement that Runtime cannot meet fails with `CAPABILITY_REQUIRED`. This handshake is separate from the Host protocol on `aotui-stdio`.

Runtime sends one object per line. The App writes and flushes one object per line. A final complete object at end of stream can also be read without a newline. The local transport limits incoming lines to 8 MiB before decoding. The host validates the content of each frame and tool receipt against their own limits. Use an `extensions` object for optional data that older peers can omit or ignore. Send additional feature messages only when both parties negotiated the feature.

## Requests and responses

Each subsequent request has a string `id`. The App echoes that ID in `{"type":"reply","id":"…","status":"…"}`. An App may have to receive and queue further requests while it waits for a publication result. Handle operations for a single App in order.

| Request `type` | Fields or result |
| --- | --- |
| `initialize` | Runtime passes `appId`, `instanceId`, `desktopId`, the registered `name`, JSON `config`, boolean `toolsEnabled`, and negotiated `capabilities`. Reply `ready`, or `failed` with an `issue` containing `code`, `message` and an optional `path`. |
| `open` | Prepare the first complete projection, then reply `done` or `failed` with an `issue`. |
| `observe` | Apply any pending business updates and prepare the latest state if needed. Reply `done` to confirm the most recent prepared frame, even when unchanged. |
| `invoke` | Runtime passes `appId`, `instanceId`, `tool` (`viewType`, `name`), `receiver` (`viewId`, `viewInstanceId`, `activationId`), the resolved `input` object and `localRefs`. Reply with `status: "tool"`, the App's own `appId` and `instanceId`, and a `terminal`. |
| `closeView` | Runtime passes `appId`, `instanceId`, `viewId`, `viewInstanceId`. Reply with the same terminal format as `invoke`. |
| `stop`, `close` | Stop new work and finish App-owned cleanup. Reply `done` with `cleanup: {state, issues}`. Normal states are `stopped` for `stop` and `completed` for `close`, with empty `issues`. To report a lifecycle failure use `failed` and `APP_STOP_FAILED` or `APP_CLEANUP_FAILED` in `issues`. The local process may exit after the close reply is flushed. |

Each local Ref carries `param`, `viewId`, `viewInstanceId`, `refId` and, for a direct array element, `index`. Check that the request targets the current App instance and receiver. Check the current tool activation, the publishing mounts and each Ref's current scope. Read only the final `input` values and check them against the current business parameter schema before entering the handler. The values come from the original observation. A Ref change after the observation can revoke access without substituting a new value.

The terminal has `phase: "not-entered"` with a failed `result` when no handler ran, `phase: "entered-returned"` with the returned `result`, or `phase: "finished-unknown"` if the App cannot confirm a result. A result is `{success:true}` with optional JSON object `data`, or `{success:false,error:{code,message}}` with optional JSON object `context` or `data`. After dispatch, Runtime preserves the original call if a Host wait times out. If the complete receipt channel ends without a valid terminal, the outcome is unknown. Runtime retains the execution slot until actual exit and pipe drain are confirmed.

## Complete projections

The App sends `{"type":"publish","id":"frame-1","opening":true,"frame":{…}}` and waits for a matching `publishResult`. The frame has three arrays.

- `views` entries have `id`, `type`, `name`, `region` (`static` or `dynamic`), raw Markdown `body`, `viewInstanceId`, and `tools`. Each tool binding is `{name, activationId}`. Set `canClose: true` when the page has its own close action.
- `refs` entries have `viewId`, `viewInstanceId`, `id`, `scope`, `valueSchema`, and JSON `value`. A nominal type can be supplied as `refType`. Use `array: true` for an ArrayRef. Ref IDs match `[A-Za-z_][A-Za-z0-9_]*`. Runtime translates the structured fields to its internal keys.
- `tools` entries have `viewType`, `name`, `multiplicity` (`single` or `multiple`), `description` and JSON `inputSchema`. List only declarations with at least one enabled View binding. All open pages of one type share the same declaration. Use the supported JSON Schema 2020-12 subset for parameter and Ref schemas.

Keep each page's `viewInstanceId` while it is open and give a new mount a fresh identity, even when reusing the same `viewId`. Each active binding has an `activationId` unique within the execution. Give it a new identity after disabling and re-enabling the tool. View IDs and mount/activation tokens belong to this App execution.

Use `opening: true` when adding or replacing a page, set it to `false` or omit it for other updates. `publishResult` has a status of `prepared`, `rejected` or `failed`. On `prepared` the App can use the candidate as its current page state. On `rejected` the previous healthy frame remains active and the App can abandon the opening. On `failed` the issue describes the invalid frame and subsequent normal observations report the failure until a healthy frame is prepared. Keep an already confirmed business write even if the presentation fails.

With the optional `attention` capability, the App can send `{"type":"attention"}` once for a meaningful background event. The Host decides whether to observe. Regular publication does not itself request a new model turn.

The [Python reference App](python-files.py) and [compatibility vectors](app-protocol-v1-vectors.json) can be saved independently of the Runtime and replayed unchanged.
