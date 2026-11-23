# AOTUI Agent Driver adapter

`@aotui/agent-driver-adapter` connects an AOTUI Runtime to `@aotui/agent-driver-v2`.
Install it in the host that uses both packages. Runtime and SDK consumers using
another Agent system do not need this adapter or this Driver.

Adapter `0.5.0` requires Runtime `8.0.0` and Driver `0.3.2` as exact peers. Use the matching local artifacts recorded by the delivery manifest. See the README shipped with `@aotui/runtime` for installing an App and managing the Runtime.

```ts
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
export async function useTurn(source: SemanticAOTUIDrivenSource) {
  const context = await source.getContext();
  try {
    await context.adopt?.();
    // Send this Context's messages and tools and use its execution bindings.
  } finally {
    await context.release?.();
  }
}
```

Create one Source per live Agent session. Keep each captured Context alive until
its model turn and tool calls finish. Releasing a Context releases its
observations. At session shutdown, `await source.dispose()` to release any
remaining Contexts, subscriptions and the Console process. When the Host saves
conversation history, await `driver.closeToolTurn()` before releasing the owning
session. It stops new dispatches and delivers one Tool message for every call in
the published assistant turn through `onToolResult`. Save that message to the
original session, including during close, and return the save promise if needed.
Runtime shutdown remains the host's separate responsibility. The Driver calls Context.adopt after the final
model input check. The Source adopts the presented App observations and uses
the Desktop to bind them to that request before it can send. The saved route
uses the binding for all its App Tools, so a `public` Ref can be used across
Apps presented in the request. On adoption or binding failure the Driver
reports an error and does not send the request. Revoked observations stay
revoked. Manual consumers must explicitly adopt too. For diagnostic rendering, use Runtime
`getAppInteraction(...).interaction.preview()` after checking the ready result.

Use `policy` to grant a Ref path to a particular receiving mount. The Source uses Runtime's `buildViewMessageMarkup` with one index of the Observations selected for the request. Available references lists a recipient-specific path only when its granted App instance and page mount are both present. A declared leaf type appears when the observation provides one. The App owns the Markdown body.

When App access is enabled, the Source advertises `system-open_app` and `system-close_app` with required string `installation_id` and `app_id`, respectively. Choose the applicable ID from the current Context's Desktop list. Open accepts `pending` or `closed` apps. Close requires a live instance in `running` or `collapsed` state and uses the instance captured by the Context. An ineligible target is rejected. `setAppsEnabled(false)` removes these App controls. Desktop previews show installation state for inspection. Context tools and their targets are scoped to the conversation.

The Desktop directory also advertises App and View collapse and expansion, and independent close for Views with an App handler. View controls use `app_id` with `view_id`. Collapse can preserve an optional note. With the Driver's model budget enabled, the Source trials complete pages, selected hints, and management-only requests against the Provider's encoded input. An expansion must fit the selected View body, or the selected App's previously expanded child bodies and collapsed child notes. Other pages can keep their budget hints. A hint retains eligible page tools and removes unshown Ref access. The original tool message can carry a budget report available through `system-read_window_budget` in the same conversation. The Source reuses the ID of an equivalent report while its original lifetime and authorization are valid, so the Driver can deduplicate unchanged requests.

App Tools use `appId-toolName` by default. When multiple registered ViewTypes in one App declare the same tool name, each uses `appId-ViewType-toolName`. An App Tool also uses the qualified form if its short name matches a reserved Desktop control, including a control currently absent from the Context.

The Source converts Runtime observations and operation receipts into Driver
messages, native tools and results. It directly wraps the final input Schema from each observed Tool. Runtime owns Ref resolution, source
binding, authorization, parameter validation and framework resources. Apps own
business state and permissions. The adapter preserves complete Driver Tool and
message contracts; it does not execute business handlers through a second path.

The Driver passes the selected Provider's tool schema policy into `getContext(policy)`. The Source selects the tools eligible on the presented windows, then checks their complete 2020-12 input schemas, including Ref alternatives. A collapsed window leaves its note. A budget hint retains its eligible tools. If an offered tool cannot be represented, the candidate for its App is released without adoption and the Desktop identifies the failing tool and Schema path. Other Apps and management controls can still be used. A Host calling the Source directly can obtain the same policy with `createProviderToolSchemaPolicy(config)` from the Driver package. Under strict modes that require every field, collapse tools use `note: ""` for no note.

The Driver sees `INVOCATION_DEADLINE_EXCEEDED` as `rejected` when the original
deadline prevented dispatch. For `INVOCATION_WAIT_TIMEOUT`, the Driver reports
`unknown` and tells the Agent that the original operation may still be running.
The Agent checks the current App View for effects before repeating it. The
trusted Host can supply `onReceiptPending(locator, result)` to retain the
original Desktop, App, instance, Observation and invocation IDs in the owning
session. The Driver supplies those execution result objects to
`onToolResult(message, results)`. At save time, the topic Host associates each
pending locator with the saved message ID and its tool call ID. A caller can
then use `readAppReceipt(topicId, { messageId, toolCallId }, timeoutMs?)` on the
topic session manager. The Host checks session ownership, App permission and
the original instance before and after Runtime's `readReceipt`. A terminal
receipt with uncertain effects retains `ACTION_OUTCOME_UNKNOWN`.

### Scoped Console

The standard Source supplies one `run_code` Tool on ordinary turns. Submit
JavaScript with top-level `await`. Variables and functions persist in the live
session, and each submission runs only its new code. Redeclaration creates a
new binding, while an older closure keeps the binding it captured. A failed
initializer preserves the previous binding, and completed changes remain.
The Tool description uses TypeScript syntax to describe the current `refs`
and `tools`. Scoped programs use JavaScript, with no cross-run type checking.

```js
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

export function createScopedSource(runtime, desktop, options = {}) {
    return new SemanticAOTUIDrivenSource(desktop, runtime, options);
}
```

Add this Source to the Driver for the lifetime of the Agent session. A Host
can use `createNodeScopedConsoleExecutor` for explicit Node or timeout settings.
Give each live Source its own executor. The first authorized run starts the
process. `reset: true` starts an empty scope before it runs the supplied code.
After a timeout, cancellation or process exit that loses the scope, rebuild local
values from the current request and check any original receipts before repeating
writes. Recovering conversation history starts with an empty Console scope.

Each run gets a new binding of `refs` and `tools` from the adopted request.
Omitting `imports` selects all presented Console Ref paths, and `[]` sets an
empty root. If a selected path loses permission before execution, the program
does not run. A saved copy can outlive its source App. Saved Tool handles expire
at the end of their run. A reusable function can look up `tools[name]` when it
is called in a new run. Output and pending callbacks are scoped to their own
run. Use separate local names when saving copies of the Console bindings.
Window recovery turns contain only their management Tools.

With OpenAI strict Chat or Responses, `run_code` requires `imports` and scoped `reset`. Use `imports: null` for the default Ref inputs of the original observation, `[]` for no Refs, or up to 256 explicit addresses. Send `reset: false` to continue or `true` to reset. One-shot Console uses `code` and `imports` only. DeepSeek strict Beta cannot encode the array limit on `imports`, so the Source reports that `run_code` requires non-strict mode there. [OpenAI strict tools](https://developers.openai.com/api/docs/guides/function-calling#strict-mode) · [DeepSeek strict Beta](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta)

### One-shot Console

For a fresh environment on every call, explicitly supply the one-shot executor.
Its function body supports erasable TypeScript, `await`, `return`, `inspect(...)`
and `console.log(...)`. The Source still presents the same `run_code` name with
the one-shot description and its own parameter schema.

```js
import { SemanticAOTUIDrivenSource, createNodeConsoleExecutor } from '@aotui/agent-driver-adapter';

export function createConsoleSource(runtime, desktop, options = {}) {
    return new SemanticAOTUIDrivenSource(desktop, runtime, {
        policy: options.policy,
        onReceiptPending: options.onReceiptPending,
        consoleExecutor: createNodeConsoleExecutor({ nodePath: options.nodePath, timeoutMs: options.timeoutMs }),
    });
}
```

Add this Source to the Driver as usual. A custom Host can use the captured
`tools`, `messages`, `adopt()`, `executeTool()`, and `release()`
at its existing send and dispatch boundaries. Observe on every turn. Release
the captured context on exit, including on failure. A supplied execution
`AbortSignal` ends the current program and prevents undispatched child
actions. The result records each child's original invocation. When
`onReceiptPending` receives a third argument, associate that child ID with the
saved parent tool message and query the original Runtime receipt.

To keep Console available for an Agent with no App access, keep the Source in
the Driver and call `source.setAppsEnabled(false)`. Its `run_code` will have an
empty `refs` root and an empty `tools` table. Per-installation restrictions
continue to apply when Apps are enabled again.

A failed child Tool returned by the Host rejects with `ToolCallError`. Catch
it to use the public tool name, AOTUI code and message and continue the program.
For example, if `notes-save` is in the current declaration:

```js
try {
    await tools['notes-save']({ text: 'draft' });
} catch (failure) {
    if (!(failure instanceof ToolCallError)) throw failure;
    inspect({ toolName: failure.toolName, code: failure.code, message: failure.message });
}
```

The bundled backend uses macOS Seatbelt and Node 24. The repository's `run.sh`
passes its Node executable to Electron. Other Electron launchers can set
`AOTUI_CONSOLE_NODE` to the absolute path of a trusted Node 24 executable.
The backend starts with an empty environment and has no project
file access, network or ability to launch child processes. Time, V8 heap,
message size, output and child-call count are bounded. Missing isolation
returns `CONSOLE_ENVIRONMENT_UNAVAILABLE` before running code. The executor
boundary accepts a trusted Host implementation for other deployment
environments. Adapted declaration, scope and process protocol code is attributed
in `LICENSE.deepseek-harness`. The child bundles Acorn with its own MIT license.

## Desktop presentation

Import the Source from `@aotui/agent-driver-adapter`. The default instruction and the helpers for tool names and View envelopes are available from `@aotui/runtime/adapters`. Instruction selection uses explicit text, an explicit instruction path, `AOTUI_SYSTEM_INSTRUCTION_PATH`, then the built-in default.

## Verification boundary

The full Source consumer uses TypeScript 7.0.2 with `strict`, `exactOptionalPropertyTypes: true` and `skipLibCheck: false`. Configure the temporary pnpm declaration patch in the consumer before installing. The exact dependency graph, patch, and removal condition are in `@aotui/agent-driver-v2` under `STRICT_TYPES.md`. Build, type and behavior results apply to the artifacts identified by the delivery manifest.

Application authors start with the README shipped with `@aotui/sdk`.
