# AOTUI Agent Driver adapter

`@aotui/agent-driver-adapter` connects an AOTUI Runtime to `@aotui/agent-driver-v2`.
Install it in the host that uses both packages. Runtime and SDK consumers using
another Agent system do not need this adapter or this Driver.

The adapter requires matching Runtime and Driver peers. The current shared source uses adapter `0.4.0-srt.1`, Runtime `7.0.0-srt.1`, SDK `0.8.0-srt.1` and
Driver `0.3.0`. These versions are not a claim of registry publication; use the matching artifacts. Do not substitute
an older Runtime: it does not provide the neutral presentation exports required
by this adapter.

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

The adapter uses Runtime observations and the Driver Context contract. Build,
behavior and normal package-consumption results apply to their recorded artifacts.
The current compiler is TypeScript 7.0.2. The accepted SRT-06 integration passes
`strict`, `exactOptionalPropertyTypes: true` and `skipLibCheck: false` with
AI SDK `6.0.326`, `@ai-sdk/provider-utils` `4.0.65` and the Driver's exact
pnpm declaration patch. An external Host must configure that patch in its own
installation; installing the Driver tar does not propagate pnpm patch settings.
See the Driver's shipped `STRICT_TYPES.md` and the
[SDK package guide](../sdk/docs/runtime-compatibility.md) for the supported graph.
The earlier unpatched eight-error result is historical, rather than a current
integration blocker. Runtime and SDK consumers using another Agent system do not
need the AI SDK patch.


当前 View 必须显式声明 `type` 和 `kind="instruction" | "state"`，实例 `id` 只标识页面实例。正文不携带框架外壳，XML 文本仅在最终呈现时转义一次；[View 声明与正文合同](../sdk/docs/views.md)说明两种 Producer、原样内容和迁移方式。

Application authors start with the [SDK guide](../sdk/README.md). Matching packages and reproducible author examples are described in the [package guide](../sdk/docs/runtime-compatibility.md).
