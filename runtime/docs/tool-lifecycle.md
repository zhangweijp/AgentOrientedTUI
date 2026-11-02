# View Tools and app cleanup

The current Worker interaction modes are `ordinary-v2` and `snapshot-value-v2`. A trusted Host selects them through `interactionModes`; omitting the option enables both supported modes, while an explicit list selects a subset. The Runtime and Worker must negotiate the selected mode before a Tool is exposed or invoked.

`ordinary-v2` carries an app-declared parameter schema and supports both read and mutating handlers. `snapshot-value-v2` carries a required, read-only Ref resolved from the invocation's captured observation. A Ref declaration must set `isMutating: false`. Neither mode removes the app's responsibility for business validation, file identity, concurrency, or actual resource effects.

## Tool execution

Apps declare View-local Tools with `useViewTypeTool(toolName, options, handler)`. An ordinary handler returns `OperationResult` after its work finishes. The Runtime captures the mounted View instance and Tool binding, validates the input, checks the current source and authorization, then dispatches through the negotiated Worker wrapper.

A failure can declare `effects: 'none' | 'partial'` only when the app knows that fact. If effects are omitted, Core retains its unknown outcome. Throwing, losing a response, aborting a waiter, or closing a Scope does not prove that a business effect did not happen. The Runtime does not add automatic retries.

The outer Tool description and parameter schema provide discovery and input validation. They do not grant permission by themselves. A tool observed earlier remains tied to the captured App, View incarnation, Observation, and Binding; the Runtime refuses it when the relevant identity or execution qualification has changed.

## App lifecycle

`createTUIApp({ app_name, component })` returns the managed factory and advertises `app-lifecycle-v2` by default. A component that owns resources registers cleanup with `useAppLifecycle({ stop?, close? })`; applications without cleanup work do not need to call the hook. There is no lifecycle opt-in config flag.

`stop` is synchronous and `close` may be asynchronous. The Runtime revokes new calls and begins managed persistence handling before it awaits app cleanup. It then disposes framework resources and keeps separate reports for callback completion and Runtime-owned resource release. Callback completion does not prove that arbitrary external processes or resources have ended; the app must wait for and report its own actual cleanup.

A late registration is stopped immediately. Unmount does not discard cleanup already registered. Preact asynchronous effect cleanup is not made awaitable by this API.

See [Runtime shutdown reports](runtime-shutdown.md), the SDK [tool lifecycle guide](../../sdk/docs/tool-lifecycle.md), and the IDE's [current app contract](../../demo-apps/aotui-ide/SCOPED_IDE.md) for integration details.
