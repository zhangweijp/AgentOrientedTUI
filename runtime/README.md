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

- A successful `observe({ all: true })` contains every opened View in the current committed frame. Use the Tools and eligible `view_id` values of that same Observation. Ref arguments resolve against the original adopted data, subject to policy and live source checks.
- Format the complete projection into XML-wrapped Markdown User Messages and supply the available Tool schemas. Check the actual request budget, including history, instructions, other Apps and reserved output, before adoption. If the request does not fit, release the candidate and keep the adopted Observation. Adopting a new one revokes the previous calling eligibility. Use `preview()` for diagnostics without adopting.
- Tool receipts describe operations. Business data and its changes appear in Views. A successful operation can be followed by a failed observation. A wait timeout can leave work in flight. Use `readReceipt({ observationId, invocationId })` with the original IDs while the record is retained. For an `unknown` outcome, use the receipt, View and App recovery instructions before deciding whether to repeat a write.
- The bundled Node Worker runs **trusted App code** with host-granted system access. The default `worker.maxWorkers` is `Number.POSITIVE_INFINITY`. Install with `toolsEnabled: false` for observation-only access. The Host can lower an App's fixed `projectionLimits` for admission. Await shutdown completion and check `resourcesReleased` before treating the Worker and its owned resources as released.
- State storage is opt-in per App. Hosts using the default SQLite backend install the optional `better-sqlite3@13.2.0` peer. Hosts with another backend can supply `storageBackend`. A staged state update becomes a confirmed save when its flush receipt reports success. Existing records in `state.sqlite3` remain readable. Automatic import of older JSON state files ended.

## Choose a package entry

- `@aotui/runtime` provides the managed Node Host and public interaction types.
- `@aotui/runtime/core` provides pure TypeScript semantics for hosts assembling their own producer, execution policy, and resource ports. `@aotui/runtime/spi` supplies the factory and integration types. Publish normalized Tool input schemas. Use `store.acquire(snapshotId)` to hold a source across turns and release the hold when its consumer finishes.
- `@aotui/runtime/adapters` provides presentation helpers. The standard Agent Driver Source lives in the separate `@aotui/agent-driver-adapter` package.

Installed declaration entry points are under `dist/`. In this repository, see the [public Host entry](src/index.ts), [Core exports](src/core/index.ts), and [integration ports](src/spi/index.ts).
