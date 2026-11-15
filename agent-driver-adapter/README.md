# AOTUI Agent Driver adapter

`@aotui/agent-driver-adapter` connects an AOTUI Runtime to `@aotui/agent-driver-v2`.
Install it in the host that uses both packages. Runtime and SDK consumers using
another Agent system do not need this adapter or this Driver.

Adapter `0.4.0` requires Runtime `7.0.0` and Driver `0.3.1` as exact peers. Use the matching local artifacts recorded by the delivery manifest. The full package graph and installation instructions are in `@aotui/runtime` under `docs/sdk-runtime-distribution.md#current-delivery`.

```ts
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import type { IDesktop, IKernel } from '@aotui/runtime/spi';

export async function useTurn(desktop: IDesktop, runtime: IKernel) {
  const source = new SemanticAOTUIDrivenSource(desktop, runtime);
  try {
    const context = await source.getContext();
    try {
      await context.adopt?.();
      // Send this Context's messages and tools and use its execution bindings.
    } finally {
      await context.release?.();
    }
  } finally {
    source.dispose();
  }
}
```

Keep the captured Context alive until its model turn and tool calls finish.
Its release method releases its observation owners; disposing the Source also
releases remaining Contexts and subscriptions. Runtime shutdown remains the
host's separate responsibility. The actual Driver run calls Context.adopt after
the final model input check and before sending the request. Successful adoption replaces earlier Context qualifications
in this Source; getContext and background publication only prepare data. Manual
consumers must explicitly adopt too. An unadopted Context refuses tool calls. For diagnostic rendering, use Runtime
`getAppInteraction(...).interaction.preview()` after checking the ready result.

An enabled Apps Source always advertises `system-open_app` and `system-close_app` with a required string `app_id`. Choose an App ID from the current Context's Desktop list. Open accepts `pending` or `closed` apps. Close requires a live instance in `running`, `collapsed`, or `paused` state and uses the instance captured by the Context. An ineligible target is rejected. Disabling the whole Apps Source removes these tools. Desktop previews show installation state for inspection. Context tools and their targets are scoped to the conversation.

The Source converts Runtime observations and operation receipts into Driver
messages, tool declarations and results. Runtime owns Ref resolution, source
binding, authorization, parameter validation and framework resources. Apps own
business state and permissions. The adapter preserves complete Driver Tool and
message contracts; it does not execute business handlers through a second path.

## Migrating the public import

Move `SemanticAOTUIDrivenSource` and `SemanticAOTUIDrivenSourceOptions` imports
from `@aotui/runtime/adapters` to `@aotui/agent-driver-adapter`. Constructor
arguments and presentation remain the same. Capture
prepares data and the new explicit adoption boundary grants invocation eligibility;
there is no implicit fallback for old consumers. Driver still releases each turn
in finally.
There is no forwarding export in Runtime that reinstalls the Driver dependency.

`DEFAULT_AOTUI_SYSTEM_INSTRUCTION` remains in `@aotui/runtime/adapters`.
Explicit instruction text, an explicit instruction path, the
`AOTUI_SYSTEM_INSTRUCTION_PATH` environment variable and the built-in default
retain their existing precedence. The existing public tool-name and View
envelope functions also remain single implementations in Runtime.

## Verification boundary

The full Source consumer uses TypeScript 7.0.2 with `strict`, `exactOptionalPropertyTypes: true` and `skipLibCheck: false`. Configure the temporary pnpm declaration patch in the consumer before installing. The exact dependency graph, patch, and removal condition are in `@aotui/agent-driver-v2` under `STRICT_TYPES.md`. Build, type and behavior results apply to the artifacts identified by the delivery manifest.

Application authors start with `@aotui/sdk` under `docs/app-authoring.md`. View declaration and content contracts are in the same package under `docs/views.md`. The full Source tutorial is in `@aotui/runtime` under `docs/semantic-host-integration.zh-CN.md#source-host-example`.
