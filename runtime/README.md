# `@aotui/runtime`

The Runtime is the Node.js Host layer for installing AOTUI applications, managing Worker execution, publishing current Views and Refs, binding observations and calls to each App instance, and reporting actual resource release.

## Choose a package entry

- `@aotui/runtime` is the Node Host entry. Use `createRuntime()` to obtain an `IKernel`, install apps, and manage Desktop and Worker lifecycles.
- `@aotui/runtime/core` is the pure TypeScript semantic Core for trusted producers and hosts that supply their own runtime integration.
- `@aotui/runtime/adapters` exports Driver-neutral presentation helpers and the default system instruction.
- `@aotui/agent-driver-adapter` separately provides `SemanticAOTUIDrivenSource`; its Runtime and Driver peers must be installed by the host.
- `@aotui/runtime/adapters/memory-state-storage` provides the in-memory StateSession storage adapter.

The Core entry does not create Workers or grant a Host policy. A Host still owns app discovery, interaction selection, authorization, storage, and shutdown.

## Standard Agent integration

Install apps through the Runtime's AppRegistry and use `SemanticAOTUIDrivenSource` as a Context-driven AgentDriver source. Each call to `getContext()` returns one coherent set of messages, Tools, and captured execution bindings. Release that same Context after the model turn and all tool calls finish:

```ts
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

const source = new SemanticAOTUIDrivenSource(desktop, runtime);
const context = await source.getContext();
try {
  // Manual consumers adopt explicitly. The normal Driver does this before its model turn.
  await context.adopt?.();
  // Use this Context's messages, tools and executeTool until the turn finishes.
} finally {
  await context.release?.();
}
source.dispose();
```

Use `runtime.getAppInteraction(desktopId, appId, expectedInstanceId, policy?)` for a running App. The ready result contains the bound interaction. Read the current instance ID from the Desktop app list. Use `preview()` for rendering without a calling observation. Use the Desktop close API to end the instance.

AppRegistry registers resolved local App packages and validates their generated manifests. The Host product package `@aotui/system-chat` provides the `agentina` executable, remote catalog discovery, and npm package installation.

## Current interaction contract

Tool execution is enabled by default. The trusted Host can install with `toolsEnabled: false` to keep View observation and preview read-only. One App/ViewType Tool contract covers ordinary parameters and multiple top-level object or object-list Refs, including optional fields and ordered arrays of Ref names. A whole-array Ref remains a single string input; a multi-selection is an array of strings. Runtime resolves the complete Ref name from the bound Observation and supplies frozen values. A read-only payload does not make the Tool read-only: the App owns business mutation and validation. Worker negotiation, activation, source checks and authorization still apply. The retired `interactionModes` option is rejected.

Preact Apps use `createTUIApp({ app_name, component })` and bind one App-level ToolSet with `AppTools`. Root lists names with `ToolCatalog`. Complete definitions belong in Context Tools. The factory advertises managed `app-lifecycle-v2` support by default. Apps that own resources register callbacks with `useAppLifecycle({ stop?, close? })`.

Each Snapshot Core captures its optional limits at creation. Overrides can only lower the default limits. The default Tool schema limit is 64 KiB of canonical JSON UTF-8 for the complete normalized profile, including its internal marker. [Pure Core configuration and migration](docs/core-public-entry.md#snapshot-limits)

The Core tracks one real operation per App instance. Use `readReceipt({ observationId, invocationId })` to read the original or late result under the instance policy. Both IDs come from the original invocation. A receipt records success, business failure, rejection before handler entry, or an unknown outcome. Read the App's error and recovery data alongside its current View before making another change. The caller's wait can end while the operation is still running.

App authors start with `README.md` and `docs/app-authoring.md` in `@aotui/sdk`. See the [local delivery guide](docs/sdk-runtime-distribution.md#current-delivery) for matching packages.

## Documentation

- [Semantic Host integration](docs/semantic-host-integration.zh-CN.md)
- [Runtime App interaction](docs/runtime-app-interaction.md)
- [Local INIT / OPEN diagnostics](docs/initialization-diagnostics.md)
- [View Tools and app cleanup](docs/tool-lifecycle.md)
- [Runtime shutdown reports](docs/runtime-shutdown.md)
- [Pure Core public entry](docs/core-public-entry.md)
- [Persistence](docs/persistence.md)
- [Worker lifecycle](docs/worker-lifecycle.md)
- [Dated package distribution evidence](docs/sdk-runtime-distribution.md)

See the repository [guide](../GUIDE.md) for package build order and local development.


当前 View 必须显式声明 `type` 和 `kind="instruction" | "state"`，实例 `id` 只标识页面实例。正文由最终消息边界包装并编码一次。两种 Producer、原样内容和迁移方式见 `@aotui/sdk` 包内 `docs/views.md`。
