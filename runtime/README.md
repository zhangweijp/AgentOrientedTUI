# @aotui/runtime

Run trusted AOTUI Apps in a Node Host. Runtime owns Worker lifecycle, complete View snapshots, Observation adoption, and Tool dispatch. The App owns business state and effects. The Host owns execution policy, the model request, and its context budget.

## Install an App and make a call

Build and package the note App from the README shipped with `@aotui/sdk`. Install `@aotui/runtime` in the Host. Save this example as `host.mjs` and pass the installed App's package directory or the entry file declared in `aoapp.json`. It prints the original note, the edited note, and the edit receipt.

`readAppManifest(localPath)` returns the declared metadata and resolved module path without importing the App. The Host chooses an installation ID for each local package it registers. `desktop.openApp(installationId)` starts the Worker and returns a `RunningApp` with its `appId` and `instanceId`. Use distinct installation IDs to register multiple copies of a package.

The Host owns its catalog, download policy, enabled Apps and auto-start. Catalog descriptions come from the manifest or the Host's bare-module installation options. For a trusted bare module, use `desktop.installDynamicWorkerApp(modulePath, { name })` with the factory's declared name. On either installation path, the Worker checks the factory's `app_name` against the registered name before business initialization. If you have the Desktop ID, use `runtime.getDesktop(desktopId)` to retrieve its handle.

```js
import { createRuntime, readAppManifest } from '@aotui/runtime';

const runtime = createRuntime();
let firstFailure = false;
let edited;
try {
  const desktop = await runtime.createDesktop();
  const localPath = process.argv[2];
  if ((await readAppManifest(localPath)).metadata.app_name !== 'notes') throw Error('Pass the note App');
  const installationId = await desktop.registerPendingApp({ installationId: 'demo_notes', localPath });
  const app = await desktop.openApp(installationId);

  async function observe() {
    const scope = desktop.createCandidateScope();
    try {
      const result = await scope.observe(app);
      if (result.status === 'rejected') throw Error(result.issue.message);
      const { candidate } = result;
      const adopted = desktop.adoptTurn({ apps: [{ candidate }] });
      if (adopted.status === 'rejected') throw Error(adopted.issue.message);
      if (adopted.cleanupIssues.length) console.error(adopted.cleanupIssues);
      return { observation: candidate.observation, turn: adopted.turn };
    } finally {
      for (const issue of scope.discard()) console.error(issue);
    }
  }

  const { observation: current, turn } = await observe();
  const tool = current.tools.find(tool => tool.name === 'edit');
  if (!tool) throw Error('Note edit tool unavailable');
  const result = await turn.invoke(app.appId, {
    observationId: current.observationId,
    toolId: tool.id,
    invocationId: 'edit-1',
    input: { text: 'Reviewed' },
  });
  if (result.kind !== 'receipt' || result.receipt.outcome.status !== 'succeeded') {
    throw Error(JSON.stringify(result));
  }

  const { observation: next, turn: nextTurn } = await observe();
  edited = {
    before: current.views.find(view => view.id === 'note')?.content.value,
    after: next.views.find(view => view.id === 'note')?.content.value,
    receipt: result.receipt,
  };
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
console.log(JSON.stringify({ ...edited, resourcesReleased: true }));
```

## Integrate with a model

The note example calls the Tool directly. A model Host follows this sequence:

1. **Open an App.** Keep the returned `RunningApp`. To find it again use `desktop.getRunningApp(appId, instanceId)` with the original identity. Set a Desktop-wide interaction policy with `createDesktop({ id, policyForApp })` or override it at `openApp(installationId, { policy })`. The running instance keeps its selected policy.
2. **Prepare candidates for the request.** Open `desktop.createCandidateScope()`. Its `scope.observe(app)` waits for queued projection commits and captures the complete published Views with compatible Refs and Tools. This process is independent of unrelated background business work. `app.preview()` reads current pages for diagnostics without creating a candidate. Call `scope.discard()` in a finally block and report any returned issues. An adopted candidate stays live through its turn. TypeScript hosts with explicit resource management can use `using scope = desktop.createCandidateScope()`.
3. **Assemble and budget the actual request.** Render the selected View bodies as XML-wrapped Markdown User Messages. The Tool schemas use JSON Schema 2020-12. Check that the chosen Provider API and mode can represent the final Tools. Omit an incompatible App candidate with its Views and routes, and report its Tool and Schema path. Count history, instructions, all sources and reserved output. Try the budget hints or management-only layout below when needed.
4. **Adopt once and send.** Call `desktop.adoptTurn({ apps })` with the complete selected candidates and windows, including an empty list for management-only. On rejection, the same scope can present a smaller selection and measure its request again before another adoption. The previous turn remains active wherever its sources and mounts are still live. Success replaces the whole turn at once and reports any cleanup issues. Keep the returned `ActiveTurn` with the request route.
5. **Invoke from that turn.** Call `turn.invoke(appId, { observationId, toolId, invocationId, input })` with the exact model route and call ID. A single-instance View receives only business arguments. Multi-instance Tools also require the receiving XML `view_id`. Use the actual XML `app_id` and `view_id` to turn a local marker like `items[0]` into an address such as `$ref.notes.detail.items[0]`. Pass ordinary text like `"$HOME"` as written.
6. **Read the receipt and close.** Save the invocation result's `locator` when present. Use `desktop.readReceipt(locator)` or pass its original `observationId` and `invocationId` to the original `app.readReceipt()`. Both apply the same instance and read-policy checks. A later adoption retires the old turn even when a candidate is reused. Call `turn.release()` when the Host no longer needs the current turn. At shutdown, await `runtime.beginClose().completion` and check both `ok` and `resourcesReleased`.

For the repository's Driver, `@aotui/agent-driver-adapter` performs Source integration. When its Apps Source is enabled, `system-open_app` takes an `installation_id` from the Desktop and returns the running `app_id`. `system-close_app` takes the running `app_id`. Two installations of the same App have distinct installation keys. Runtime allocates public App IDs in start order, using the declared name and successive suffixes when needed. App Tool aliases and the adoption hook are documented in the adapter's README. Other Agent systems can use Runtime directly. A Host that assembles its own Desktop can use the exported `createCandidateScope` from `@aotui/runtime` as its scope factory. Each observed App supplies its own `observe()` method.

The shared presenter puts `view_id`, `view_type`, `app_id`, `app_name` and `region` on every View's XML element. The Host uses the region to place messages. An unchanged static page can keep its previous position.

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

For model calls, pass the measured tool table, model tool name, original arguments and call ID to `routeNativeInvocation` from `@aotui/runtime/adapters`. On `ready`, pass its `appId` and invocation to `turn.invoke`. This extracts the top-level `view_id` of multi-instance tools and preserves all business fields. A route belongs to the turn whose tool table was sent. Use `turn.inspectRef(address, mode)` for the inspection tool.

### Present and manage windows

Read `desktop.getAppWindows(appId, instanceId)` for current mounts and their close capability. The Host owns folded presentation and optional notes keyed by the original App instance and View mount. On collapse, call `desktop.revokeWindowAccess(turn, target)` with the request's current `ActiveTurn` before recording the note. The target is `{ appId, instanceId }` for an App and includes `viewId` and `viewInstanceId` for a View. Stale turns and replaced mounts are rejected. On expand, change the Host layout and prepare a new observation. Previously revoked business or Ref access stays revoked. A collapsed View with `canClose` still supports `desktop.closeView(target, turn)`. The model's public `app_id` and `view_id` select targets captured in its request.

This single-App example builds one candidate for a complete request or a budget trial. A collapsed App contributes its note in the Desktop directory. A management-only request contributes the directory and its controls.

`view.content.value` is the complete Markdown body. Pass it as-is to `buildViewMessageMarkup` to preserve spacing, line endings and code indentation. The adapter escapes the XML and adds one newline at each body boundary.

```ts
import type { AppWindows, Observation } from '@aotui/runtime';
import { projectDesktop, type ViewPresentation, type WindowPresentation } from '@aotui/runtime/adapters';

export function presentWindows(appName: string, observation: Observation, app: AppWindows,
  presentation: WindowPresentation, hint: (body: string) => string,
  notes: ReadonlyMap<string, string> = new Map()) {
  const windows = new Map<string, ViewPresentation>();
  for (const view of observation.views) {
    const note = notes.get(view.viewInstanceId);
    windows.set(view.viewInstanceId, note !== undefined ? { kind: 'collapsed', note } :
      presentation.hints.has(view.viewInstanceId) ? { kind: 'hint', text: hint(view.content.value) } : { kind: 'body' });
  }
  const result = projectDesktop({
    apps: [{ observation, windows }], compact: presentation.managementOnly, capabilities: [],
    catalog: [{
      app: { installationId: app.appId, name: appName, status: 'running', appId: app.appId, appInstanceId: app.instanceId },
      windows: { ...app, expanded: !notes.has(''), views: app.views.map(view =>
        ({ ...view, expanded: !notes.has(view.viewInstanceId) })) },
    }],
  });
  if (result.issues.length) throw Error(JSON.stringify(result.issues));
  return {
    pages: result.views.map(({ region, content }) => ({ role: 'user' as const, region, content })),
    tools: result.tools, selection: result.appSelections[0]?.windows ?? { activeViews: [] },
  };
}
```

Budget the actual encoded request including other sources, history, paired receipts, management tools and reserved output. `fitWindowPresentation` can try budget hints for the same captured pages and fall back to management-only. After the final measurement, include `{ candidate, windows: selection }` for each participating App in the single `adoptTurn` call. Only pages shown in full can receive business calls and supply Refs. A page showing a budget hint stays open and can still be collapsed or closed. Adopting its full body on a later turn restores eligibility. Reusing a candidate keeps its selected windows and creates a fresh turn. Prepare a new candidate to change its selection.

Collapse revokes new work through the affected mounts immediately. A new adoption after expansion is required to restore eligibility. To preflight expansion, run the same `fitWindowPresentation` with `{ keepBodies: targetMountKeys, requireBodies: true }` against the prospective directory and paired operation result. Use the captured target View key, or the keys of all still-open, individually expanded Views in the target App. Keep notes for its individually collapsed Views. The returned measurement can exceed the input limit. In that case keep the existing collapse note. If the expansion succeeds, prioritize those keys in the next ordinary fit with `{ keepBodies: targetMountKeys }` and adopt only the measured request. Use the same mount keys as in `candidates`.

A Host that exposes paged reports can reuse a live report ID when its content and authorized mount identities match. Rechecking a report leaves its original expiration in place. Deduplicate only after encoding the entire request, including its report ID.

A successful close results in `closed` once Runtime confirms the original mount is gone, or `accepted` while removal is unconfirmed. Refusals and unknown outcomes carry a diagnostic. In-flight invocations settle against their original instance.

### Share and inspect Refs

An observation’s grant lists whole Ref identities. Add `consumers` to a grant to further restrict tool use to the listed App and View instances. Omit it to use the declared scope, or use an empty list for no receiving mounts. A body-visible Ref is inspectable in `schema` mode. In `value` mode the Ref must also be public in the original observation and still public on its publishing mount. Object keys and array indices select part of the original value without changing the permission. Host changes to grants take effect when adopting its next request; closing or folding a source immediately revokes the current turn’s related access.

Use `projectDesktop` once for the whole filtered catalog. It projects business tools from eligible receiving pages and Refs from the displayed bodies. The adapter adds a Ref string branch only when a compatible source can reach a receiver. The Runtime rechecks the exact destination and argument at execution.

Addresses have the form `$ref.app_id.view_id.ref_id` with optional paths, for example `$ref.contacts.list.people[0]["display.name"]`. Only a complete business argument or a direct array element is eligible for resolution. If a literal at one of those positions starts with one or more dollar signs followed by `ref.`, add one leading `$`. Send literal `$ref.x` as `$$ref.x` and literal `$$ref.x` as `$$$ref.x`.

Adopting a new turn revokes the previous turn's calls and Ref resolution, including when a candidate is reused. Observations and already dispatched invocations can hold their original snapshots until their work ends. Runtime drops its reference to a retired snapshot when its final holder releases it.

A successful business operation can be followed by a failed observation. Recover the projection from actual business state rather than repeating the write. A wait timeout can leave the original operation in flight: it does not prove cancellation or non-execution. Use `readReceipt({ observationId, invocationId })` with the original IDs while the receipt record is retained. Reading a receipt does not restore old invocation eligibility. For an `unknown` outcome, follow the receipt, current View and App recovery instructions before deciding whether to repeat a write.

Invocation records prevent duplicate dispatch within their retained scope; they do not provide business exactly-once execution across restarts. Apps own external conflict handling, long-running task progress and business compensation. Runtime owns the calls it dispatched, necessary source holds and late settlement. A shutdown request alone does not establish that Workers have physically exited.

### Bind Console input to the current request

The Driver Adapter includes `run_code`. Its business functions use the same `turn.invoke` route and address syntax as Native tools. Use `await turn.readPublicRefs(addresses?)` to receive validated entries with `appId`, `viewId`, `refId`, `path` and the value from the original observation. The Console builds its nested input tree and rechecks access immediately before user code runs. Omitted `imports` selects all public Refs from the original presented body pages, `[]` selects none, and addresses select a subset. Runtime checks current permissions with each selected Worker before returning original observation values and their paths. Losing access to any selected path rejects preparation before code runs. Tool and Ref declarations come from the Observation. Use `turn.inspectRef(address, 'schema')` or `tools["system-inspect_ref"]` to inspect an individual Ref schema.

```ts
import type { ActiveTurn } from '@aotui/runtime';

export async function selectConsoleInputs(turn: ActiveTurn) {
  const address = '$ref.contacts.list.people[0].email';
  const declaration = await turn.inspectRef(address, 'schema');
  const selected = await turn.readPublicRefs([address]);
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

Start with `initialize({protocol: "aotui-stdio", majorVersion: 1, capabilities: {required: [], optional: ["output-events", "command-apps"]}})`. The response lists the accepted capabilities. With `output-events`, call `subscribeOutput({apps})` with the running App handles to receive separate `{event: "output", signal}` frames. `command-apps` enables local external App registration with a fixed executable and argument list.

Register a package with `registerApp` and open its instance with `openApp`. To send a model request:

1. Call `beginCandidateScope`, then `observe({scopeId, app})` for each selected App.
2. Call `presentTurn` with the scope ID, filtered catalog installation IDs, supported control capabilities and each candidate’s display choices. Its response includes the View messages, desktop directory, default instruction, model tools and a `presentation` identifier. Measure the entire model request. A new trial in the same scope replaces the previous presentation.
3. Call `adoptTurn({scopeId, presentation})` for the chosen trial. Send its measured messages and tools after successful adoption. If adoption fails, revise the layout and measure again. In a finally block call `discardScope({scopeId})` and report cleanup issues. The adopted turn owns its selected observations.
4. Pass the model’s business call directly to `invokeNative({turn, name, invocationId, input})`. A multi-page call carries its top-level `view_id` in the model input. Use the returned locator with `readDesktopReceipt`. End a turn with `releaseTurn`.

The Python example keeps layout and notes in the Host. `getAppWindows` returns current mounts. `revokeWindowAccess` and `closeView` take the turn and the original App and View identities. Requests can overlap. Match replies by `id` and await dependent operations in order. Close stdin or request `shutdown` to finish and check the resource report.

### Close and reopen a Desktop

Import `IKernel`, `IDesktop`, and close handles and reports from `@aotui/runtime`. Pass launch settings as `config` when registering each App. The App receives these settings in its author context.

Keep the `RunningApp` or `IDesktop` that owns the work. `app.beginClose()`, `desktop.beginClose()` and `runtime.beginClose()` return the same kind of handle. Closing immediately stops new work. Ordinary close preserves business data. To restart an App, check its close report and open the installation again for a fresh instance. Use the App's explicit business operations to delete its data.

`handle.wait({ timeoutMs })` bounds the caller's wait. If it returns `deadline`, retain the handle for the eventual report. `report.ok` answers whether all close stages succeeded. `report.resourcesReleased` answers whether the runtime can reuse the ID. An App can confirm its last save and still hold a resource. If a dispatched Tool was still running when close began, the App report's `closingInvocation` records its original IDs and confirmed or unknown outcome. Once the attempt settles, call `beginClose()` again on the same owner or a still-closing parent to retry release. The new report retains the first failure and the original handle retains its report. The App's cleanup and writes run once.

Runtime shutdown stops admission and starts the registered Desktops and the Runtime's shared Worker capacity before waiting. The final report also accounts for admitted work that settles during shutdown.

## Managed execution and limits

The bundled Node Worker runs **trusted App code** with Host-granted system access. It provides execution and lifecycle boundaries, rather than a filesystem or network permission sandbox; see [Node Worker documentation](https://nodejs.org/api/worker_threads.html). Install with `toolsEnabled: false` for observation-only access. Host policy and live execution checks remain separate from Tool discovery.

The default `worker.maxWorkers` is `Number.POSITIVE_INFINITY`; explicit finite settings keep their existing validation and counting. Projection limits and the Host model budget are separate. For a batch of selected Apps, register and open each installation separately and retain its specific result.

The Host can lower an App's `projectionLimits` at installation. That immutable configuration is shared by Worker admission, Host observation and the SDK's read-only author context. It bounds complete per-App projection counts and JSON sizes. Snapshot, Ref payload and Tool Schema limits also apply. Managed opening admission uses `hostedObservationCapacityIssue` from `@aotui/core/host`, including the bytes of the Native Tool schemas with receiver routing and Ref hints. App pagination and reversible opening handle local capacity. The Host measures its assembled model request separately.

The Worker submits the first frame on App open. Following commits send lightweight notices. `preview()` and `observe()` ask the Worker for a complete current projection or a short confirmation when it still matches the accepted frame. Both wait for queued App commits. The Host can coalesce preview reads while its preview is open. Formal observations go straight to Runtime and each successful `observe()` creates a fresh candidate with an observation ID. The candidate's `source.snapshotId` identifies the snapshot and `source.revision` tracks changes in its content.

`desktop.output` carries `view_updated`, `projection_failed`, `projection_recovered`, `app_opened`, `app_closed`, and `attention_requested` with the originating `appId` and `instanceId`. Use projection and lifecycle notices to refresh an open preview. The Host decides whether a current, enabled App's `attention_requested` merits a new model request. Native calls and Ref reads confirm current eligibility even while preview is closed. An eligible value is read from the original observation.

Apps own their own business state, persistence and save confirmation. Hosts may pass data directory paths or launch settings through `config`. Close stops business admission, gives the App's cleanup callback time to settle (`appCleanup`), confirms physical Worker exit and interaction release (`resourcesReleased`), and preserves failures separately in the close report.

For a low-level factory, `AppLifecyclePort.register(callbacks)` returns a function that starts those callbacks early. Formal close joins the same cleanup and reports its outcome. With the SDK, authors register callbacks using `registerCleanup`, which returns `void`.

## Versions and distribution

Use SDK 0.9.0 and Runtime 8.0.0 from the same delivery. Both select Core 0.1.0. Regenerate the App manifest when rebuilding. The current boundaries identify their own formats:

| Boundary | Current identifier |
| --- | --- |
| App factory and `aoapp.json` | `view-type-tools-v8` |
| Snapshot | `schemaVersion: 8` |
| Worker initialization and operation transport | `app-worker/v10` with App update notices, on-demand frames, mount-bound actions and local Ref checks |
| App lifecycle | `app-lifecycle-v2` |

Use the bundled Worker with its matching Runtime build. A mismatched initialization marker reports `WORKER_PROTOCOL_UNSUPPORTED`. The marker is internal to the handshake. Hosts can receive model usage through their model Driver.

These identifiers are boundary checks, not a cross-version negotiation or fallback mechanism. Local release checks build and consume the matching Node ESM packages and run independent Python v1 clients.

## Choose a package entry

- `@aotui/runtime` provides the managed Node Host and public interaction types.
- `@aotui/core` provides portable projection, observation, execution and App factory contracts for users assembling their own execution environment. Its package ships `examples/public-core.ts` and documents it in its README.
- `@aotui/runtime/adapters` provides presentation helpers. The standard Agent Driver Source lives in `@aotui/agent-driver-adapter`.

Custom Core consumers use `store.acquire(snapshotId)` for an explicit source hold, check its result and release the hold when finished. Holds have ownership rather than a lease timeout; observation and in-flight call lifetimes remain authoritative for their own holds. Receipt retention and execution deadlines are separate contracts.

Installed declarations are under `dist/` and consumed through the package exports above. [Host declarations](dist/index.d.ts)
