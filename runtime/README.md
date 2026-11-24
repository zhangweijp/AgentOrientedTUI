# @aotui/runtime

Run trusted AOTUI Apps in a Node Host. Runtime owns Worker lifecycle, complete View snapshots, Observation adoption, and Tool dispatch. The App owns business state and effects. The Host owns execution policy, the model request, and its context budget.

## Install an App and make a call

Build and package the counter with the README shipped with `@aotui/sdk`. Install `@aotui/runtime` in the Host. Save this example as `host.mjs` and pass the installed App's package directory or the entry file declared in `aoapp.json`. It prints both observed View bodies and the receipt for the increment.

`readAppManifest(localPath)` returns the declared metadata and resolved module path without importing the App. The Host chooses an installation ID for each local package it registers. `desktop.openApp(installationId)` starts the Worker and returns a `RunningApp` with its `appId` and `instanceId`. Use distinct installation IDs to register multiple copies of a package. The installation ID is the default storage namespace key. The Host can override it with `AOTUI_APP_KEY` in launch config.

The Host owns its catalog, download policy, enabled Apps and auto-start. Catalog descriptions come from the manifest or the Host's bare-module installation options. For a trusted bare module, use `desktop.installDynamicWorkerApp(modulePath, { name })` with the factory's declared name. On either installation path, the Worker checks the factory's `app_name` against the registered name before business initialization. If you have the Desktop ID, use `runtime.getDesktop(desktopId)` to retrieve its handle.

```js
import { createRuntime, readAppManifest } from '@aotui/runtime';

const runtime = createRuntime();
let firstFailure = false;
try {
  const desktop = await runtime.createDesktop();
  const localPath = process.argv[2];
  if ((await readAppManifest(localPath)).metadata.app_name !== 'counter') throw Error('Pass the counter App');
  const installationId = await desktop.registerPendingApp({ installationId: 'demo_counter', localPath });
  const app = await desktop.openApp(installationId);

  async function observe() {
    const result = await app.observe();
    if (result.status === 'rejected') throw Error(result.issue.message);
    const { candidate } = result;
    const adopted = desktop.adoptTurn({ apps: [{ candidate }] });
    if (adopted.status === 'rejected') {
      candidate.discard();
      throw Error(adopted.issue.message);
    }
    return { observation: candidate.observation, turn: adopted.turn };
  }

  const { observation: current, turn } = await observe();
  const tool = current.tools.find(tool => tool.name === 'add');
  if (!tool) throw Error('Counter tool unavailable');
  const result = await turn.invoke(app.appId, {
    observationId: current.observationId,
    toolId: tool.id,
    invocationId: 'increment-1',
    input: { by: 1 },
  });
  if (result.kind !== 'receipt' || result.receipt.outcome.status !== 'succeeded') {
    throw Error(JSON.stringify(result));
  }

  const { observation: next, turn: nextTurn } = await observe();
  console.log(JSON.stringify({
    before: current.views.find(view => view.id === 'counter')?.content.value,
    after: next.views.find(view => view.id === 'counter')?.content.value,
    receipt: result.receipt,
  }));
  nextTurn.release();
} catch (error) {
  firstFailure = true;
  throw error;
} finally {
  const close = await runtime.beginClose().completion;
  if (!close.resourcesReleased || !close.ok) {
    if (!firstFailure) throw Error(JSON.stringify(close));
    console.error(close);
  }
}
```

## Integrate with a model

The counter example has no model request. A model Host follows this sequence:

1. **Open an App.** Keep the returned `RunningApp`. To find it again use `desktop.getRunningApp(appId, instanceId)` with the original identity. Set a Desktop-wide interaction policy with `createDesktop({ id, policyForApp })` or override it at `openApp(installationId, { policy })`. The running instance keeps its selected policy.
2. **Prepare a candidate.** `app.observe()` waits for queued projection commits and captures the complete published Views with compatible Refs and Tools. This process is independent of unrelated background business work. `app.preview()` reads current pages for diagnostics without creating a candidate. Call `candidate.discard()` when abandoning a prepared candidate.
3. **Assemble and budget the actual request.** Render the selected View bodies as XML-wrapped Markdown User Messages. The Tool schemas use JSON Schema 2020-12. Check that the chosen Provider API and mode can represent the final Tools. Omit an incompatible App candidate with its Views and routes, and report its Tool and Schema path. Count history, instructions, all sources and reserved output. Try the budget hints or management-only layout below when needed.
4. **Adopt once and send.** Call `desktop.adoptTurn({ apps })` with the complete selected candidates and windows, including an empty list for management-only. On rejection, discard the failed attempt's unused candidates. The previous turn remains active wherever its sources and mounts are still live. Success replaces the whole turn at once and reports any cleanup issues. Keep the returned `ActiveTurn` with the request route.
5. **Invoke from that turn.** Call `turn.invoke(appId, { observationId, toolId, invocationId, input })` with the exact model route and call ID. A single-instance View receives only business arguments. Multi-instance Tools also require the receiving XML `view_id`. Use the actual XML `app_id` and `view_id` to turn a local marker like `items[0]` into an address such as `$ref.notes.detail.items[0]`. Pass ordinary text like `"$HOME"` as written. Use `$$ref.` when an entire argument or direct array element is literal text beginning with `$ref.`.
6. **Read the receipt and close.** Save the invocation result's `locator` when present. Use `desktop.readReceipt(locator)` or pass its original `observationId` and `invocationId` to the original `app.readReceipt()`. Both apply the same instance and read-policy checks. A later adoption retires the old turn even when a candidate is reused. Call `turn.release()` when the Host no longer needs the current turn. At shutdown, await `runtime.beginClose().completion` and check both `ok` and `resourcesReleased`.

For the repository's Driver, `@aotui/agent-driver-adapter` performs Source integration. When its Apps Source is enabled, `system-open_app` takes an `installation_id` from the Desktop and returns the running `app_id`. `system-close_app` takes the running `app_id`. Two installations of the same App have distinct installation keys. Runtime allocates public App IDs in start order, using the declared name and successive suffixes when needed. App Tool aliases and the adoption hook are documented in the adapter's README. Other Agent systems can use Runtime directly.

The shared `buildViewMessageMarkup` helper emits four XML attributes, `view_id`, `view_type`, `app_id` and `app_name`, and encodes the Markdown body. Use each observed page's `region` to place its message. Static pages append on first adopted presentation and after visible changes. An unchanged static presentation retains its previous position.

## Source binding, receipts and recovery

Refs resolve to captured read-only JSON values from their own original Observations. Runtime checks both the receiver and Ref source, including their App run, page mount and live eligibility. A private Ref requires the publishing mount. A protected Ref is usable in the same App run. A public Ref, including a complete ArrayRef or a terminal array element, can also be used by another App presented in the same model request. If a publisher updates a still-eligible Ref, the call receives the old observed value. Closing or reopening either instance, removing the Ref, or restricting its scope can revoke permission before dispatch. Apps check business existence, object ownership and external conflicts.

The Host selects exact candidates issued by the same Desktop, one per running App. The target's own candidate must belong to the turn. The model can supply `{ "to": "$ref.contacts.list.emails" }` to the saved mail tool route.

```ts
// Both candidates are included in the budgeted request.
const adopted = desktop.adoptTurn({ apps: [{ candidate: contactsCandidate }, { candidate: mailCandidate }] });
if (adopted.status === 'rejected') {
  contactsCandidate.discard();
  mailCandidate.discard();
  throw new Error(adopted.issue.message);
}
const { turn } = adopted;
try {
  const call = await sendToModel(); // This request's saved route selects setRecipients.
  const result = await turn.invoke(mail.appId, {
    observationId: mailCandidate.observation.observationId,
    toolId: setRecipients.id,
    invocationId: call.id,
    input: call.args,
  });
} finally {
  turn.release();
}
```

Use the same entry for same-App calls. The model uses `view_id` only on multi-instance tools. Remove it from `input` and pass it as `AppInvocation.viewId`. Implement `system-inspect_ref` with `await turn.inspectRef(address, mode)`.

### Present and manage windows

Read `desktop.getAppWindows(appId, instanceId)` for current mounts and their close capability. The Host owns folded presentation and optional notes keyed by the original App instance and View mount. On collapse, call `desktop.revokeWindowAccess(turn, target)` with the request's current `ActiveTurn` before recording the note. The target is `{ appId, instanceId }` for an App and includes `viewId` and `viewInstanceId` for a View. Stale turns and replaced mounts are rejected. On expand, change the Host layout and prepare a new observation. Previously revoked business or Ref access stays revoked. A collapsed View with `canClose` still supports `desktop.closeView(target, turn)`. The model's public `app_id` and `view_id` select targets captured in its request.

This single-App example builds one candidate for a complete request or a budget trial. A collapsed App contributes its note in the Desktop directory. A management-only request contributes the directory and its controls.

`view.content.value` is the complete Markdown body. Pass it as-is to `buildViewMessageMarkup` to preserve spacing, line endings and code indentation. The adapter escapes the XML and adds one newline at each body boundary.

```ts
import type { AppWindows, Observation, ObservationWindowSelection } from '@aotui/runtime';
import { buildViewMessageMarkup, collapsedWindowText, type WindowPresentation } from '@aotui/runtime/adapters';

export function presentWindows(appName: string, observation: Observation, app: AppWindows,
  presentation: WindowPresentation, hint: (body: string) => string,
  notes: ReadonlyMap<string, string> = new Map()) {
  const shown = !notes.has('') && !presentation.managementOnly ? observation.views : [];
  const receivers = shown.filter(view => !notes.has(view.viewInstanceId));
  const bodies = receivers.filter(view => !presentation.hints.has(view.viewInstanceId));
  const identity = (view: Observation['views'][number]) => ({ viewId: view.id, viewInstanceId: view.viewInstanceId });
  const selection: ObservationWindowSelection = { receiverViews: receivers.map(identity), refViews: bodies.map(identity) };
  const pages = shown.map(view => {
    const note = notes.get(view.viewInstanceId);
    const body = bodies.includes(view);
    return { role: 'user' as const, region: view.region, content: buildViewMessageMarkup({
      appId: app.appId, appName, viewId: view.id, viewType: view.type,
      markup: note !== undefined ? collapsedWindowText(note) : body ? view.content.value : hint(view.content.value),
      refs: body ? observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId) : [],
    }) };
  });
  const tools = observation.tools.filter(tool => receivers.some(view => view.type === tool.viewType &&
    (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id))));
  return { pages, tools, selection };
}
```

Budget the actual encoded request including other sources, history, paired receipts, management tools and reserved output. `fitWindowPresentation` can try budget hints for the same captured pages and fall back to management-only. After the final measurement, include `{ candidate, windows: selection }` for each participating App in the single `adoptTurn` call. A budget hint retains the page identity and permitted Tools. Only complete displayed bodies can provide Refs. Reusing a candidate keeps its selected windows and creates a fresh turn. Prepare a new candidate to change its selection.

Collapse revokes new work through the affected mounts immediately. A new adoption after expansion is required to restore eligibility. To preflight expansion, run the same `fitWindowPresentation` with `{ keepBodies: targetMountKeys, requireBodies: true }` against the prospective directory and paired operation result. Use the captured target View key, or the keys of all still-open, individually expanded Views in the target App. Keep notes for its individually collapsed Views. The returned measurement can exceed the input limit. In that case keep the existing collapse note. If the expansion succeeds, prioritize those keys in the next ordinary fit with `{ keepBodies: targetMountKeys }` and adopt only the measured request. Use the same mount keys as in `candidates`.

A Host that exposes paged reports can reuse a live report ID when its content and authorized mount identities match. Rechecking a report leaves its original expiration in place. Deduplicate only after encoding the entire request, including its report ID.

A successful close results in `closed` once Runtime confirms the original mount is gone, or `accepted` while removal is unconfirmed. Refusals and unknown outcomes carry a diagnostic. In-flight invocations settle against their original instance.

### Share and inspect Refs

An observation’s grant lists whole Ref identities. Add `consumers` to a grant to further restrict tool use to the listed App and View instances. Omit it to use the declared scope, or use an empty list for no receiving mounts. A body-visible Ref is inspectable in `schema` mode. In `value` mode the Ref must also be public in the original observation and still public on its publishing mount. Object keys and array indices select part of the original value without changing the permission. Host changes to grants take effect when adopting its next request; closing or folding a source immediately revokes the current turn’s related access.

Use `buildViewMessageMarkup` with the body-visible Ref descriptions. Use `projectNativeToolSchema(tool, source, receiverViews, references)` from `@aotui/runtime/adapters` to project the underlying business schema as a native function. The receiving views must match the observed ViewType and eligibility for that tool. Pass the actual Ref descriptions from body-visible pages in the request. The adapter adds a Ref string branch only when a compatible source can reach a receiver. The Runtime rechecks the exact destination and argument at execution.

Addresses have the form `$ref.app_id.view_id.ref_id` with optional paths, for example `$ref.contacts.list.people[0]["display.name"]`. Only a complete business argument or a direct array element is eligible for resolution. Use `$$ref.` for literal text beginning with `$ref.`.

Adopting a new turn revokes the previous turn's calls and Ref resolution, including when a candidate is reused. Observations and already dispatched invocations can hold their original snapshots until their work ends. Runtime drops its reference to a retired snapshot when its final holder releases it.

A successful business operation can be followed by a failed observation. Recover the projection from actual business state rather than repeating the write. A wait timeout can leave the original operation in flight: it does not prove cancellation or non-execution. Use `readReceipt({ observationId, invocationId })` with the original IDs while the receipt record is retained. Reading a receipt does not restore old invocation eligibility. For an `unknown` outcome, follow the receipt, current View and App recovery instructions before deciding whether to repeat a write.

Invocation records prevent duplicate dispatch within their retained scope; they do not provide business exactly-once execution across restarts. Apps own external conflict handling, long-running task progress and business compensation. Runtime owns the calls it dispatched, necessary source holds and late settlement. A shutdown request alone does not establish that Workers or storage resources have physically exited.

### Bind Console input to the current request

The Driver Adapter includes `run_code`. Its business functions use the same `turn.invoke` route and address syntax as Native tools. Use `await turn.readConsoleInputs(imports?)` to prepare a detached, read-only projection of public inputs. Omitted `imports` selects all public Refs from the original presented body pages, `[]` selects none, and addresses select a subset. Runtime checks current permissions with each selected Worker before returning original observation values and their paths. Losing access to any selected path rejects preparation before code runs. Tool and Ref declarations come from the Observation. Use `turn.inspectRef(address, 'schema')` or `tools["system-inspect_ref"]` to inspect an individual Ref schema.

```ts
import type { ActiveTurn } from '@aotui/runtime';

export async function selectConsoleInputs(turn: ActiveTurn) {
  const address = '$ref.contacts.list.people[0].email';
  const declaration = await turn.inspectRef(address, 'schema');
  const selected = await turn.readConsoleInputs([address]);
  return { declaration, selected };
}
```

The Worker receives validated effective arguments and just the local Ref identities needed for final checks. It rechecks the local registration before calling App code. Calls that have begun keep their original execution and receipt even if the Host’s wait is cancelled.


## Connect a local stdio Host

Install `@aotui/runtime`, `@aotui/sdk` and `typebox` for the bundled [TypeScript file App](examples/files/app.mts). From the installed consumer, run the [Python standard-library example](examples/python-host.py) on Node 24 and Python 3.11 or later.

```sh
python3 node_modules/@aotui/runtime/examples/python-host.py
```

`node_modules/.bin/aotui-stdio` runs one Runtime and Desktop per local client. Send one JSON object per line on stdin with an `id` (string or integer), `method`, and optional `params` object. Read one JSON response per line on stdout with the same `id` and either `result` or `error` (`code`, `message`, optional `path`). App logs go to stderr. Semantic rejections such as a failed adoption are returned as a typed result, as they are in TypeScript.

Use `registerApp` and `openApp` for a trusted local package, then `observe`, `adoptTurn`, `invoke` and `readReceipt`. Call `projectNativeTools` with the same `{ apps }` selection intended for `adoptTurn`. Each eligible business tool includes a model-facing `name`, `description` and `schema` alongside its original `observationId` and `toolId`. Route the model's chosen name to those saved IDs. Names use the same rules as the TypeScript adapter, which adds the ViewType when a bare App alias would repeat or collide with a reserved name. The projection uses only selected receiving mounts and Refs from selected bodies. A naming error identifies the offending App so the client can revise the selection before adoption.

Use `readDesktopReceipt` to pass the invocation's saved locator. `discardObservation` abandons a candidate. `releaseTurn` ends the current turn. `getAppWindows` takes the App handle. `revokeWindowAccess` and `closeView` require the current `turn` and `app` handles. A View target also requires `viewId` and `viewInstanceId`. The Python example uses its folded layout to build Messages and passes the same `receiverViews` and `refViews` to schema projection and adoption. The client owns notes and model budgeting. The local Node process uses Runtime's default interaction policy. Call `shutdown` for a resource report or close stdin and await the process exit. Treat the bridge as trusted local IPC.

### Close and reopen a Desktop

Import `IKernel`, `IDesktop`, and close handles and reports from `@aotui/runtime`. Pass launch settings as `config` when registering each App. The App receives these settings in its author context.

Keep the `RunningApp` or `IDesktop` that owns the work. `app.beginClose()`, `desktop.beginClose()` and `runtime.beginClose()` return the same kind of handle. Closing immediately stops new work. Ordinary close preserves business data. To restart an App, check its close report and open the installation again for a fresh instance. Use the App's explicit business operations to delete its data.

`handle.wait({ timeoutMs })` bounds the caller's wait. If it returns `deadline`, retain the handle for the eventual report. `report.ok` answers whether all close stages succeeded. `report.resourcesReleased` answers whether the runtime can reuse the ID. An App can confirm its last save and still hold a resource. If a dispatched Tool was still running when close began, the App report's `closingInvocation` records its original IDs and confirmed or unknown outcome. Once the attempt settles, call `beginClose()` again on the same owner or a still-closing parent to retry release. The new report retains the first failure and the original handle retains its report. The App's cleanup and writes run once.

Runtime shutdown stops admission and starts the registered Desktops and the Runtime's shared Worker capacity before waiting. The final report also accounts for admitted work that settles during shutdown.

## Managed execution, limits and storage

The bundled Node Worker runs **trusted App code** with Host-granted system access. It provides execution and lifecycle boundaries, rather than a filesystem or network permission sandbox; see [Node Worker documentation](https://nodejs.org/api/worker_threads.html). Install with `toolsEnabled: false` for observation-only access. Host policy and live execution checks remain separate from Tool discovery.

The default `worker.maxWorkers` is `Number.POSITIVE_INFINITY`; explicit finite settings keep their existing validation and counting. This removes the default ten-App Worker cap. It does not enlarge projection limits, remove other startup failures or change the model context budget. For a batch of selected Apps, register and open each installation separately and retain its specific result.

The Host can lower an App's `projectionLimits` at installation. That immutable configuration is shared by Worker admission, Host observation and the SDK's read-only author context. It bounds complete per-App projection counts and JSON sizes. Snapshot, Ref payload and Tool Schema limits also apply. Managed opening admission uses `hostedObservationCapacityIssue` from `@aotui/core/host`, including the bytes of the Native Tool schemas with receiver routing and Ref hints. App pagination and reversible opening handle local capacity. The Host measures its assembled model request separately.

The Worker submits the first frame on App open. Following commits send lightweight notices. `preview()` and `observe()` ask the Worker for a complete current projection or a short confirmation when it still matches the accepted frame. Both wait for queued App commits. The Host can coalesce preview reads while its preview is open. Formal observations go straight to Runtime and each successful `observe()` creates a fresh candidate with an observation ID. The candidate's `source.snapshotId` identifies the snapshot and `source.revision` tracks changes in its content.

`desktop.output` carries `view_updated`, `projection_failed`, `projection_recovered`, `app_opened`, `app_closed`, and `attention_requested` with the originating `appId` and `instanceId`. Use projection and lifecycle notices to refresh an open preview. The Host decides whether a current, enabled App's `attention_requested` merits a new model request. Native calls and Ref reads confirm current eligibility even while preview is closed. An eligible value is read from the original observation.

Small JSON storage is opt-in through the App's `persistence: true`. For packaged Apps the SDK generates this capability from `package.json`, and the Worker requires the manifest and factory declarations to agree before initialization. A bare module can request storage through its factory alone. The App calls `load`, `save`, or `remove` and decides whether read data changes its View. A save succeeds after the backend confirms it. The default namespace combines the Desktop and stable installation ID, with `AOTUI_APP_KEY` or the App's explicit `storageKey` available for an existing space.

Hosts using the default SQLite backend explicitly install the optional `better-sqlite3@13.2.0` peer. A Host can supply a `storageBackend` typed as `StateStorageBackend` from `@aotui/core/persistence`. Runtime and Worker load managed storage when the App requests it. The default backend opens one storage Worker per physical directory on first access. It coordinates namespace ownership across Runtime instances in that process and closes when the last user releases it. Close reports include `persistence` only when an App requested it. `resources` counts retained owners and pending operations. Existing v1 records in `state.sqlite3` keep their format.

Close stops business admission and gives the App's cleanup callback time to complete explicit saves. Runtime then seals storage, waits for the captured mutation results and actual I/O, and releases the original owner. Check both the close result and physical resource release. A lost mutation response stays unknown and never triggers an automatic retry.

Close reports track App cleanup and storage separately. An App cleanup failure can make the overall close fail with a confirmed flush and released resources. Inspect `appCleanup`, `persistence`, and the stages in `failures` to identify which operation failed. Missing or invalid storage receipts still count as storage failures.

## Versions and distribution

Use SDK 0.9.0 and Runtime 8.0.0 from the same delivery. Both select Core 0.1.0. Regenerate the App manifest when rebuilding. The current boundaries identify their own formats:

| Boundary | Current identifier |
| --- | --- |
| App factory and `aoapp.json` | `view-type-tools-v7` |
| Snapshot | `schemaVersion: 8` |
| Worker initialization and operation transport | `app-worker/v10` with App update notices, on-demand frames, mount-bound actions and local Ref checks |
| App lifecycle | `app-lifecycle-v2` |
| Optional App persistence port and storage negotiation | `state-session-v2` |
| SQLite record envelope | `version: 1` |

Use the bundled Worker with its matching Runtime build. A mismatched initialization marker reports `WORKER_PROTOCOL_UNSUPPORTED`. The marker is internal to the handshake. Hosts can receive model usage through their model Driver.

An opted-in App with an incompatible storage port fails before its initializer with `PERSISTENCE_UNAVAILABLE`. Rebuild its factory and manifest with the matching SDK.

These identifiers are boundary checks, not a cross-version negotiation or fallback mechanism. Current consumption has been verified with local Node ESM package builds and the pinned SDK Preact baseline. SQLite's native module must match the Host's Node or Electron ABI. This is not a claim of published artifacts, an unrestricted renderer matrix or complete platform distribution support.

## Choose a package entry

- `@aotui/runtime` provides the managed Node Host and public interaction types.
- `@aotui/core` provides portable projection, observation, execution and App factory contracts for users assembling their own execution environment. Its package ships `examples/public-core.ts` and documents it in its README.
- `@aotui/runtime/adapters` provides presentation helpers. `@aotui/runtime/adapters/memory-state-storage` provides an in-memory backend. The standard Agent Driver Source lives in `@aotui/agent-driver-adapter`.

Custom Core consumers use `store.acquire(snapshotId)` for an explicit source hold, check its result and release the hold when finished. Holds have ownership rather than a lease timeout; observation and in-flight call lifetimes remain authoritative for their own holds. Receipt retention and execution deadlines are separate contracts.

Installed declarations are under `dist/` and consumed through the package exports above. [Host declarations](dist/index.d.ts)
