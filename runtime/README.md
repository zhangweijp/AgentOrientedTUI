# `@aotui/runtime`

The Runtime is the Node.js Host layer for installing AOTUI applications, managing Worker execution, publishing current Views and Refs, enforcing interaction Scopes, and reporting actual resource release.

## Choose a package entry

- `@aotui/runtime` is the Node Host entry. Use it to create a Runtime, install apps, and manage Desktop and Worker lifecycles.
- `@aotui/runtime/core` is the pure TypeScript semantic Core for trusted producers and hosts that supply their own runtime integration.
- `@aotui/runtime/adapters` exports Runtime integrations, including `SemanticAOTUIDrivenSource`.
- `@aotui/runtime/adapters/memory-state-storage` provides the in-memory StateSession storage adapter.

The Core entry does not create Workers or grant a Host policy. A Host still owns app discovery, interaction selection, authorization, storage, and shutdown.

## Standard Agent integration

Install apps through the Runtime's AppRegistry and use `SemanticAOTUIDrivenSource` as a Context-driven AgentDriver source. Each call to `getContext()` returns one coherent set of messages, Tools, and captured execution bindings. Release that same Context after the model turn and all tool calls finish:

```ts
import { SemanticAOTUIDrivenSource } from '@aotui/runtime/adapters';

const source = new SemanticAOTUIDrivenSource(desktop, runtime);
const context = await source.getContext();
try {
  // Give context.messages, context.tools, and context.executeTool to the Driver.
} finally {
  await context.release?.();
}
source.dispose();
```

For integrations that own their own policy, use `runtime.createAppScope(desktopId, appId, policy)`. It opens a Scope for a running app; it does not start a pending app or allocate another Worker.

## Current interaction contract

Hosts select `ordinary-v2` and/or `snapshot-value-v2` through the trusted `interactionModes` install option. If omitted, both supported modes are enabled. `ordinary-v2` supports regular parameterized Tools, including mutations. `snapshot-value-v2` supports a required, read-only Ref resolved from the captured observation. Both require Worker negotiation and per-Tool execution qualification.

Apps use `createTUIApp({ app_name, component })` and declare View-local Tools with the SDK's `useViewTypeTool`. The factory advertises managed `app-lifecycle-v2` support by default. Apps that own resources opt in to callbacks with `useAppLifecycle({ stop?, close? })`; apps with no app-owned cleanup do not need the hook.

The Core keeps operation receipts within their Scope and reports whether an operation succeeded, failed with known effects, was rejected, was accepted, or remains unknown. A success result carries concise operation data; business content belongs in the app's current View. Unknown outcomes do not imply that no side effect occurred and are not automatically retried.

## Documentation

- [Semantic Host integration](docs/semantic-host-integration.zh-CN.md)
- [Runtime App interaction](docs/runtime-app-interaction.md)
- [View Tools and app cleanup](docs/tool-lifecycle.md)
- [Runtime shutdown reports](docs/runtime-shutdown.md)
- [Pure Core public entry](docs/core-public-entry.md)
- [Persistence](docs/persistence.md)
- [Worker lifecycle](docs/worker-lifecycle.md)
- [Dated package distribution evidence](docs/sdk-runtime-distribution.md)

See the repository [guide](../GUIDE.md) for package build order and local development.
