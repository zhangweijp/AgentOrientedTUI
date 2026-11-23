# @aotui/runtime

Run trusted AOTUI Apps in a Node Host. Runtime owns Worker lifecycle, complete View snapshots, Observation adoption, and Tool dispatch. The App owns business state and effects. The Host owns execution policy, the model request, and its context budget.

## Install an App and make a call

Build and package the counter with the README shipped with `@aotui/sdk`. Install `@aotui/runtime` in the Host. Save this example as `host.mjs` and pass the installed App's package directory or the entry file declared in `aoapp.json`. It prints both observed View bodies and the receipt for the increment.

`readAppManifest(localPath)` returns the declared metadata and resolved module path without importing the App. The Host chooses an installation ID for each local package it registers. Registration makes the App discoverable; `desktop.openApp(installationId)` starts the Worker and returns the running App ID. Use distinct installation IDs to register multiple copies of the same App. The installation ID is the default storage namespace key, unless the Host supplies `AOTUI_APP_KEY` in launch config.

The Host owns its catalog, download policy, enabled Apps and auto-start. For a trusted bare module, use `runtime.installDynamicWorkerApp(desktopId, modulePath, { name })` with the factory's declared name. At startup, the Worker checks the actual factory name before business initialization on either path.

```js
import { createRuntime, readAppManifest } from '@aotui/runtime';

const runtime = createRuntime();
try {
  const desktopId = await runtime.createDesktop();
  const desktop = runtime.getDesktop(desktopId);
  const localPath = process.argv[2];
  if ((await readAppManifest(localPath)).metadata.app_name !== 'counter') throw Error('Pass the counter App');
  const installationId = await desktop.registerPendingApp({ installationId: 'demo_counter', localPath });
  const appId = await desktop.openApp(installationId);
  const instanceId = desktop.getInstalledApps().find(app => app.appId === appId)?.appInstanceId;
  if (!instanceId) throw Error('App instance unavailable');
  const access = runtime.getAppInteraction(desktopId, appId, instanceId);
  if (access.status !== 'ready') throw Error(access.issue.message);
  const client = access.interaction;

  async function observe() {
    const result = await client.observe({ all: true });
    if (result.status !== 'observed') throw Error(result.issue.message);
    const observation = result.observation;
    if (client.adoptObservation(observation.observationId).status !== 'adopted') {
      client.releaseObservation(observation.observationId);
      throw Error('Observation could not be adopted');
    }
    return observation;
  }

  const current = await observe();
  const tool = current.tools.find(tool => tool.name === 'add');
  if (!tool) throw Error('Counter tool unavailable');
  const result = await client.invoke({
    observationId: current.observationId,
    toolId: tool.id,
    invocationId: 'increment-1',
    input: { by: 1 },
  });
  if (result.kind !== 'receipt' || result.receipt.outcome.status !== 'succeeded') {
    throw Error(JSON.stringify(result));
  }

  const next = await observe();
  console.log(JSON.stringify({
    before: current.views.find(view => view.id === 'counter')?.content.value,
    after: next.views.find(view => view.id === 'counter')?.content.value,
    receipt: result.receipt,
  }));
  client.releaseObservation(next.observationId);
} finally {
  const close = await runtime.beginShutdown().completion;
  if (!close.resourcesReleased || !close.ok) throw Error(JSON.stringify(close));
}
```

## Integrate with a model

The counter example has no model request. A model Host follows this sequence:

1. **Install and acquire an interaction.** Keep the App's runtime instance identity and choose its execution policy. Check installation results before offering the App to the Agent.
2. **Observe completely.** `observe({ all: true })` waits for the App's queued projection refresh and captures every opened View with compatible Refs and Tools. It does not wait for unrelated background business work. Projection failures remain diagnostics; do not present them as normal snapshots.
3. **Assemble and budget the actual request.** Format raw View bodies into XML-wrapped Markdown User Messages once. The Observation's final Tool schemas use JSON Schema 2020-12, including fixed tuple positions and whole-value Ref alternatives. Check whether the selected Provider API and strict mode can represent every branch. Release an incompatible App candidate before adoption and omit its Views and routes together. Report the App, Tool, Schema path and reason. Count history, instructions, all App sources, other context and reserved output. If the complete request exceeds the limit, try budget hints or the management-only request below. If even that request exceeds the limit, release the candidate and retain the adopted source.
4. **Adopt, bind and send.** After checking the final request, adopt each presented Observation. Use `desktop.bindRequestSources({ apps })` to bind the successfully adopted set for a request that accepts cross-App references. Send only after both steps succeed. Adoption replaces the previous Observation's calling eligibility. If anything fails after adoption starts, release the request's observations. Revoked observations do not regain eligibility. `preview()` and background publication do not adopt anything.
5. **Invoke from the saved request route.** Use its `observationId`, Tool ID, request binding and the provider's call-specific `invocationId`. A single-instance View receives only the declared business arguments. A multiple-instance Tool requires the receiving XML `view_id` string. Runtime checks eligibility against adopted Observations and live mounts. A full address such as `$notes.detail.items[0]` selects a compatible, published Ref in the original request. Double the first dollar sign for literal text starting with a dollar sign.
6. **Read the receipt, observe changes and close.** Receipts report operations and recovery information; business data appears in the next successful observation. Release unused observations. At shutdown, await `runtime.beginShutdown().completion` and check both `ok` and `resourcesReleased`.

For the repository's Driver, `@aotui/agent-driver-adapter` performs Source integration. When its Apps Source is enabled, `system-open_app` takes an `installation_id` from the Desktop and returns the running `app_id`. `system-close_app` takes the running `app_id`. Two installations of the same App have distinct installation keys. Runtime allocates public App IDs in start order, using the declared name and successive suffixes when needed. App Tool aliases and the adoption hook are documented in the adapter's README. Other Agent systems can use Runtime directly.

The shared `buildViewMessageMarkup` helper emits four XML attributes, `view_id`, `view_type`, `app_id` and `app_name`, and encodes the Markdown body. Use each observed page's `region` to place its message. Static pages append on first adopted presentation and after visible changes. An unchanged static presentation retains its previous position.

## Source binding, receipts and recovery

Refs resolve to captured read-only JSON values from their own original Observations. Runtime checks both the receiver and Ref source, including their App run, page mount and live eligibility. A private Ref requires the publishing mount. A protected Ref is usable in the same App run. A public Ref, including a complete ArrayRef or a terminal array element, can also be used by another App presented in the same model request. If a publisher updates a still-eligible Ref, the call receives the old observed value. Closing or reopening either instance, removing the Ref, or restricting its scope can revoke permission before dispatch. Apps check business existence, object ownership and external conflicts.

The Host keeps the binding with its model request route. Bind the exact clients issued by the same Desktop and one adopted Observation per running App. The target's own Observation must be included. An invalid selection fails with `REQUEST_SOURCES_INVALID`. The model can supply `{ "to": "$contacts.list.emails" }` to the saved mail tool route.

```ts
// Both clients were issued by desktop and are present in the budgeted request.
const apps = [
  { client: contacts, observationId: contactsObservation.observationId },
  { client: mail, observationId: mailObservation.observationId },
];
try {
  for (const { client, observationId } of apps) {
    const adopted = client.adoptObservation(observationId);
    if (adopted.status === 'rejected') throw new Error(adopted.issue.message);
  }
  const sources = desktop.bindRequestSources({ apps });
  const call = await sendToModel(); // This request's saved route selects setRecipients.
  const result = await mail.invoke({
    observationId: mailObservation.observationId,
    toolId: setRecipients.id,
    invocationId: call.id,
    input: call.args,
  }, undefined, sources);
} finally {
  for (const { client, observationId } of apps) client.releaseObservation(observationId);
}
```

The original two-argument `invoke(request, timeoutMs?)` remains available for same-App calls. Source binding is a Host capability. Model inputs contain only the declared arguments and any required `view_id`.

### Present and manage windows

Read `desktop.getAppWindows(appId, instanceId)` after observing the App. A present `note` means collapsed, including an empty note. Keep the real App and mount IDs in the request route. `collapseApp` accepts a note after the expected instance ID. `collapseView`, `expandView` and `closeView` take `{ appId, instanceId, viewId, viewInstanceId }`. `expandApp` replaces `showApp`. The corresponding model controls use public string IDs `app_id` and `view_id`.

This single-App example builds one candidate for a complete request or a budget trial. In a multi-App request, build the rendering index from all the selected receiving mounts before rendering pages. A collapsed App contributes its note in the Desktop directory. A management-only request contributes the directory and its controls.

`view.content.value` is the complete Markdown body. Pass it as-is to `buildViewMessageMarkup` to preserve spacing, line endings and code indentation. The adapter escapes the XML and adds one newline at each body boundary.

```ts
import type { AppWindows, Observation, ObservationWindowSelection } from '@aotui/runtime';
import { buildViewMessageMarkup, collapsedWindowText, type WindowPresentation } from '@aotui/runtime/adapters';

export function presentWindows(appName: string, observation: Observation, app: AppWindows,
  presentation: WindowPresentation, hint: (body: string) => string) {
  const notes = new Map(app.views.map(view => [view.viewInstanceId, view.note]));
  const shown = app.note === undefined && !presentation.managementOnly ? observation.views : [];
  const receivers = shown.filter(view => notes.get(view.viewInstanceId) === undefined);
  const bodies = receivers.filter(view => !presentation.hints.has(view.viewInstanceId));
  const identity = (view: Observation['views'][number]) => ({ viewId: view.id, viewInstanceId: view.viewInstanceId });
  const selection: ObservationWindowSelection = { receiverViews: receivers.map(identity), refViews: bodies.map(identity) };
  const index = new Map([[app.appId, { source: observation.source, views: receivers }]]);
  const pages = shown.map(view => {
    const note = notes.get(view.viewInstanceId);
    const body = bodies.includes(view);
    return { role: 'user' as const, region: view.region, content: buildViewMessageMarkup({
      appId: app.appId, appName, viewId: view.id, viewType: view.type,
      markup: note !== undefined ? collapsedWindowText(note) : body ? view.content.value : hint(view.content.value),
      refs: body ? observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId) : [],
    }, index) };
  });
  const tools = observation.tools.filter(tool => receivers.some(view => view.type === tool.viewType &&
    (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id))));
  return { pages, tools, selection };
}
```

Budget the actual encoded request including other sources, history, paired receipts, management tools and reserved output. `fitWindowPresentation` can try budget hints for the same captured pages and fall back to management-only. Call `client.adoptObservation(observation.observationId, selection)` only after the final measurement, then bind the selected business sources. A budget hint retains the page identity and permitted Tools. Only complete displayed bodies can provide Refs. Retrying the same selection is idempotent. A different selection requires a new Observation.

Collapse revokes new work through the affected mounts immediately. A new adoption after expansion is required to restore eligibility. To preflight expansion, run the same `fitWindowPresentation` with `{ keepBodies: targetMountKeys, requireBodies: true }` against the prospective directory and paired operation result. Use the captured target View key, or the keys of all still-open, individually expanded Views in the target App. Keep notes for its individually collapsed Views. The returned measurement can exceed the input limit. In that case keep the existing collapse note. If the expansion succeeds, prioritize those keys in the next ordinary fit with `{ keepBodies: targetMountKeys }` and adopt only the measured request. Use the same mount keys as in `candidates`.

A Host that exposes paged reports can reuse a live report ID when its content and authorized mount identities match. Rechecking a report leaves its original expiration in place. Deduplicate only after encoding the entire request, including its report ID.

A successful close results in `closed` once Runtime confirms the original mount is gone, or `accepted` while removal is unconfirmed. Refusals and unknown outcomes carry a diagnostic. In-flight invocations settle against their original instance.

### Grant fields to a particular View

A Host can grant paths through `AppInteractionPolicy.project`. Use the receiving App's read-only `preview()` to identify the draft even when the publishing App is observed first. Keep that mount identity for the life of the grant. In `project`, pass `source` and the allowed paths to `grantPeople`, for example `[{ path: [0, 'email'], consumer }]` once `getDraftConsumer` returns a receiver. Copy this TypeScript module into the Host project.

```ts
import type { AppInteraction, AppInteractionPolicy, Observation, ObservationGrant, RefConsumer, RefPathGrant } from '@aotui/runtime';
import { buildViewMessageMarkup } from '@aotui/runtime/adapters';

export async function getDraftConsumer(mail: AppInteraction): Promise<RefConsumer | undefined> {
  const preview = await mail.preview();
  if (preview.status !== 'previewed') return;
  const draft = preview.views.find(view => view.id === 'draft');
  if (draft) return { appId: preview.source.appId, instanceId: preview.source.instanceId,
    viewId: draft.id, viewInstanceId: draft.viewInstanceId };
}

export function grantPeople(source: Parameters<AppInteractionPolicy['project']>[0]['source'],
  paths: readonly RefPathGrant[]): ObservationGrant {
  const people = Object.values(source.refs).find(ref => ref.id === 'people' && ref.ownerViewId === 'list');
  return { toolIds: Object.keys(source.tools), refs: people ? [{
    refId: people.id, viewId: people.ownerViewId, viewInstanceId: people.ownerViewInstanceId, paths,
  }] : [] };
}

export function renderAppMessages(selection: readonly { appName: string; observation: Observation }[]) {
  const presentedByApp = new Map(selection.map(({ observation }) => [observation.source.appId, observation] as const));
  return selection.flatMap(({ appName, observation }) => observation.views.map(view => ({
    role: 'user' as const,
    content: buildViewMessageMarkup({
      appId: observation.source.appId, appName, viewId: view.id, viewType: view.type, markup: view.content.value,
      refs: observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId),
    }, presentedByApp),
  })));
}
```

Omitting `paths` grants the whole Ref within its publishing scope. An empty list grants no paths. An empty path grants the whole Ref to its stated consumer. A path permits its subtree. String keys such as `"0"` and numeric array indices such as `0` are distinct. Release or replace the adopted observation before enforcing a narrower policy. Invocation still requires the actual target mount in the request's adopted observations.

Pass the observations selected for this request to `renderAppMessages`. Use the same selection for the Tool list, request budgeting, adoption and binding. `buildViewMessageMarkup` checks each path's consumer against that index and includes a declared leaf type when available. Omitting the index displays only hints without a designated consumer. When the draft is present, the model can provide `{ "to": "$contacts.list.people[0].email" }` to its tool using the saved route above.

Adopting a new Observation revokes further calls and Ref resolution through the old one. A valid Observation or already dispatched invocation can still hold the old source data until its responsibility ends. Once the last holder releases a retired snapshot, Runtime drops its reference; physical JavaScript garbage collection has its own timing. A data hold does not grant invocation authority.

A successful business operation can be followed by a failed observation. Recover the projection from actual business state rather than repeating the write. A wait timeout can leave the original operation in flight: it does not prove cancellation or non-execution. Use `readReceipt({ observationId, invocationId })` with the original IDs while the receipt record is retained. Reading a receipt does not restore old invocation eligibility. For an `unknown` outcome, follow the receipt, current View and App recovery instructions before deciding whether to repeat a write.

Invocation records prevent duplicate dispatch within their retained scope; they do not provide business exactly-once execution across restarts. Apps own external conflict handling, long-running task progress and business compensation. Runtime owns the calls it dispatched, necessary source holds and late settlement. A shutdown request alone does not establish that Workers or storage resources have physically exited.

### Bind Console input to the current request

Use the Agent Driver adapter for the standard `run_code` integration. Hosts that implement their own integration can request `observe({ all: true, programTools: true })`. `programInput.schema` describes the declared business JSON and any required `view_id`. `programInput.refOnly` identifies parameters or array elements that still require a published Ref address. The same Tool's `inputSchema` remains the native model interface. If the added Console metadata cannot fit the observation limit, the observation retains its native Views and Tools and omits the program metadata.

Console is a separate consumer of `public` Refs. An unqualified grant can apply to both Console and native calls. A grant for a specific receiving View applies to that View. To allow a field solely for Console, use `consumer: 'console'` in `project`.

```ts
import type { AppInteractionPolicy, ObservationGrant, RequestSources } from '@aotui/runtime';

export function grantEmail(source: Parameters<AppInteractionPolicy['project']>[0]['source']): ObservationGrant {
  const people = Object.values(source.refs).find(ref => ref.ownerViewId === 'list' && ref.id === 'people');
  return { toolIds: Object.keys(source.tools), refs: people ? [{
    viewId: people.ownerViewId, viewInstanceId: people.ownerViewInstanceId, refId: people.id,
    paths: [{ path: [0, 'email'], consumer: 'console' }],
  }] : [] };
}

export function selectedConsoleInputs(sources: RequestSources) {
  return sources.readConsoleInputs(['$contacts.list.people[0].email']);
}
```

Use `ObservedRef.programPaths` from selected, body-visible Views to generate `refs` declarations before measuring the request. After adoption, `sources.readConsoleInputs(imports?)` returns selected types and detached read-only data from that same request. Omission selects all Console paths in the adopted presentation. An empty list selects none. If any selected path is unavailable or revoked, preparation fails as a whole. A still-authorized path uses the original value through background updates. Only a trusted Host sets `inputMode: 'program'` on `client.invoke(request, timeoutMs, sources, signal)`. Ordinary arguments then carry literal JSON and `refOnly` positions keep their addresses. Cancellation can stop admission or end the wait for an already-dispatched operation. Keep its original IDs to read the receipt.

### Close and reopen a Desktop

Import `IKernel`, `IDesktop`, and close handles and reports from `@aotui/runtime`. Pass launch settings as `config` when registering each App. The App receives these settings in its author context.

Keep the `IDesktop` for work owned by a particular session. Its `isClosing` flag becomes true as soon as close is accepted. `desktop.beginClose()` acts on that object. `runtime.beginDesktopShutdown(id)` selects the currently registered object and shares the handle for a compatible close. `desktop.delete()` and `runtime.deleteDesktop(id)` request deletion explicitly.

`handle.wait({ timeoutMs })` bounds the caller's wait. If it returns `deadline`, retain the handle for the eventual report. The ID becomes reusable before `handle.completion` resolves with `resourcesReleased: true`, including a release that reports cleanup failures. If a report shows that retryable storage is still held, another close request on the same Desktop retries the release. Previously returned handles keep their reports.

Runtime shutdown stops admission and starts the registered Desktops and the Runtime's shared Worker capacity before waiting. The final report also accounts for admitted work that settles during shutdown.

## Managed execution, limits and storage

The bundled Node Worker runs **trusted App code** with Host-granted system access. It provides execution and lifecycle boundaries, rather than a filesystem or network permission sandbox; see [Node Worker documentation](https://nodejs.org/api/worker_threads.html). Install with `toolsEnabled: false` for observation-only access. Host policy and live execution checks remain separate from Tool discovery.

The default `worker.maxWorkers` is `Number.POSITIVE_INFINITY`; explicit finite settings keep their existing validation and counting. This removes the default ten-App Worker cap. It does not enlarge projection limits, remove other startup failures or change the model context budget. For a batch of selected Apps, register and open each installation separately and retain its specific result.

The Host can lower an App's `projectionLimits` at installation. That immutable configuration is shared by Worker admission, Host observation and the SDK's read-only author context. It bounds complete per-App projection counts and JSON sizes. Snapshot, Ref payload and Tool Schema limits also apply. App pagination and reversible opening handle local capacity. The Host measures its assembled model request separately.

Each managed Preact App reads its existing healthy local projection through its own Core coordinator when a normal update skips rendering. A local preparation result carries the App's `sourceEpoch`. Managed Workers send a complete frame on their first successful refresh. Later refreshes can confirm an already received healthy publication after waiting for queued commits. A successful `observe()` still creates a fresh Observation. Adoption and model request budgeting remain Host decisions.

Small JSON storage is opt-in through the App's `persistence: true`. The App explicitly calls `load`, `save`, or `remove` and decides whether read data changes its View. A save succeeds after the backend confirms it. The default namespace combines the Desktop and stable installation ID, with `AOTUI_APP_KEY` or the App's explicit `storageKey` available for an existing space.

Hosts using the default SQLite backend explicitly install the optional `better-sqlite3@13.2.0` peer. The first access lazily creates a dedicated storage Worker and connection per physical storage root. A Host can supply a `storageBackend` instead. Existing v1 records in `state.sqlite3` keep their format. Apps own business data migrations.

Close stops business admission and gives the App's cleanup callback time to complete explicit saves. Runtime then seals storage, waits for the captured mutation results and actual I/O, and releases the original owner. Check both the close result and physical resource release. A lost mutation response stays unknown and never triggers an automatic retry.

Close reports track App cleanup and storage separately. An App cleanup failure can make the overall close fail with a confirmed flush and released resources. Inspect `appCleanup`, `persistence`, and the stages in `failures` to identify which operation failed. Missing or invalid storage receipts still count as storage failures.

## Versions and distribution

Use SDK 0.9.0 and Runtime 8.0.0 from the same delivery. Both select Core 0.1.0. Regenerate the App manifest when rebuilding. The current boundaries identify their own formats:

| Boundary | Current identifier |
| --- | --- |
| App factory and `aoapp.json` | `view-type-tools-v7` |
| Snapshot | `schemaVersion: 7` |
| Worker initialization and operation transport | `app-worker/v6` with mount-bound close actions, complete Ref provenance, fixed `toolsEnabled` and checked `projectionLimits` |
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

Installed declarations are under `dist/` and consumed through the package exports above. [Host declarations](dist/index.d.ts) · [Environment port declarations](dist/spi/index.d.ts)
