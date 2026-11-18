# @aotui/runtime

Run trusted AOTUI Apps in a Node Host. Runtime owns Worker lifecycle, complete View snapshots, Observation adoption, and Tool dispatch. The App owns business state and effects. The Host owns execution policy, the model request, and its context budget.

## Install an App and make a call

Use Runtime 8.0.0 and SDK 0.9.0 from the same delivery. Build the counter in the README shipped with `@aotui/sdk`. Put the following in `host.mjs` in the same project and run `node host.mjs ./dist/app.js`. To install packaged Apps by manifest, use `AppRegistry`.

```js
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@aotui/runtime';

const runtime = createRuntime();
try {
  const desktopId = await runtime.createDesktop();
  const appId = await runtime.installDynamicWorkerApp(desktopId, pathToFileURL(resolve(process.argv[2])).href);
  const desktop = runtime.getDesktop(desktopId);
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
    input: { view_id: 'counter', by: 1 },
  });
  if (result.kind !== 'receipt' || result.receipt.outcome.status !== 'succeeded') {
    throw Error(JSON.stringify(result));
  }

  const next = await observe();
  console.log(next.views.find(view => view.id === 'counter')?.content.value);
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
3. **Assemble and budget the actual request.** Format raw View bodies into XML-wrapped Markdown User Messages once, and attach that Observation's Tool schemas. Count history, instructions, all App sources, other context and reserved output. If it does not fit, release the candidate and retain the adopted source; silently omitting opened pages is invalid.
4. **Adopt, then send.** Call `adoptObservation` after the final request check, check its result, and send the matching messages and tools. Adoption replaces the previous Observation's calling eligibility. Keep the source alive until its turn and calls finish. `preview()` and background publication do not adopt anything.
5. **Invoke from that source.** Use its `observationId`, Tool id and a call-specific `invocationId`. The framework consumes required `view_id`, validates the receiving page instance and passes business arguments to its context. Explicit Ref addresses can select another View in the same App instance and original Observation.
6. **Read the receipt, observe changes and close.** Receipts report operations and recovery information; business data appears in the next successful observation. Release unused observations. At shutdown, await `runtime.beginShutdown().completion` and check both `ok` and `resourcesReleased`.

For the repository's Driver, the separate [Agent Driver adapter](../agent-driver-adapter/README.md) performs Source integration. When its Apps Source is enabled, fixed `system-open_app` and `system-close_app` tools take an `app_id` selected from the current Desktop list. App Tool aliases and the adoption hook are documented there. Other Agent systems can use Runtime directly.

## Source binding, receipts and recovery

Refs resolve to captured read-only JSON values from the call's original Observation. Runtime checks both the receiver and Ref source, including their App run, page mount and live eligibility. Closing and reopening a page with the same id cannot redirect an old call to the new instance. A shared ViewType Tool can remain active for another page while the closed page is unavailable. App business checks still decide whether the observed object exists, belongs to the right parent and may be changed now.

Adopting a new Observation revokes further calls and Ref resolution through the old one. A valid Observation or already dispatched invocation can still hold the old source data until its responsibility ends. Once the last holder releases a retired snapshot, Runtime drops its reference; physical JavaScript garbage collection has its own timing. A data hold does not grant invocation authority.

A successful business operation can be followed by a failed observation. Recover the projection from actual business state rather than repeating the write. A wait timeout can leave the original operation in flight: it does not prove cancellation or non-execution. Use `readReceipt({ observationId, invocationId })` with the original IDs while the receipt record is retained. Reading a receipt does not restore old invocation eligibility. For an `unknown` outcome, follow the receipt, current View and App recovery instructions before deciding whether to repeat a write.

Invocation records prevent duplicate dispatch within their retained scope; they do not provide business exactly-once execution across restarts. Apps own external conflict handling, long-running task progress and business compensation. Runtime owns the calls it dispatched, necessary source holds and late settlement. A shutdown request alone does not establish that Workers or storage resources have physically exited.

## Managed execution, limits and storage

The bundled Node Worker runs **trusted App code** with Host-granted system access. It provides execution and lifecycle boundaries, rather than a filesystem or network permission sandbox; see [Node Worker documentation](https://nodejs.org/api/worker_threads.html). Install with `toolsEnabled: false` for observation-only access. Host policy and live execution checks remain separate from Tool discovery.

The default `worker.maxWorkers` is `Number.POSITIVE_INFINITY`; explicit finite settings keep their existing validation and counting. This removes the default ten-App Worker cap. It does not enlarge projection limits, remove other startup failures or change the model context budget. `AppRegistry.installAll()` returns per-App results; failed installation can roll back the installed entry, so a Host should retain and expose failures rather than infer success from the remaining list.

The Host can lower an App's `projectionLimits` at installation. That immutable configuration is shared by Worker admission, Host observation and the SDK's read-only author context. It bounds complete per-App projection counts and JSON sizes. Snapshot, Ref payload and Tool Schema limits also apply; their defaults are in the repository's [snapshot limits](src/core/snapshot/snapshot-support.ts) and [observation limits](src/core/invocation/observation-registry.ts). These byte and count limits are not the assembled request's token budget. App pagination and reversible opening handle local capacity; automatic allocation from remaining model space is not provided.

Framework state storage is opt-in through the App's `persistence: true`. Hosts using the default SQLite backend explicitly install the optional `better-sqlite3@13.2.0` peer; the backend lazily uses a dedicated storage Worker and connection per physical storage root. Pure Core, Apps without framework persistence and custom `storageBackend` consumers do not require that native driver. A staged update becomes a confirmed save when its flush receipt reports success. Current records in `state.sqlite3` remain readable. Older JSON files are left untouched and are not automatically imported. Apps own business data migrations.

## Versions and distribution

Use matching SDK 0.9.0 and Runtime 8.0.0 artifacts and regenerate the App manifest when rebuilding. The current boundaries identify their own formats:

| Boundary | Current identifier |
| --- | --- |
| App factory and `aoapp.json` | `view-type-tools-v6` |
| Snapshot | `schemaVersion: 6` |
| Worker initialization | `app-worker/v1` with fixed `toolsEnabled` and checked `projectionLimits` |
| App lifecycle | `app-lifecycle-v2` |
| Optional state session | `state-session-v1` |

These identifiers are boundary checks, not a cross-version negotiation or fallback mechanism. Current consumption has been verified with local Node ESM package builds and the pinned SDK Preact baseline. SQLite's native module must match the Host's Node or Electron ABI. This is not a claim of published artifacts, an unrestricted renderer matrix or complete platform distribution support.

## Choose a package entry

- `@aotui/runtime` provides the managed Node Host and public interaction types.
- `@aotui/runtime/core` provides pure TypeScript semantics for hosts assembling their own producer, execution policy and resource ports. Core owns shared interaction definitions; `@aotui/runtime/spi` composes factory and environment integration types. Producers supply complete frames and normalized Tool schemas. The repository's [Core consumer](tests/fixtures/public-core.ts) shows the lower-level assembly.
- `@aotui/runtime/adapters` provides presentation helpers; `/adapters/dom` and `/adapters/memory-state-storage` provide the existing DOM and in-memory storage adaptations. The standard Agent Driver Source lives in the separate `@aotui/agent-driver-adapter` package.

Custom Core consumers use `store.acquire(snapshotId)` for an explicit source hold, check its result and release the hold when finished. Holds have ownership rather than a lease timeout; observation and in-flight call lifetimes remain authoritative for their own holds. Receipt retention and execution deadlines are separate contracts.

Installed declarations are under `dist/` and consumed through the package exports above. Source and fixture links in this README refer to the repository: [public Host entry](src/index.ts), [Core exports](src/core/index.ts), [integration ports](src/spi/index.ts), and [interaction types](src/core/invocation/app-interaction-types.ts).
