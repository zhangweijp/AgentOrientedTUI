# ViewType Tools, Ref parameters, and app cleanup

The trusted Host can set `toolsEnabled: false` for read-only observation. Tool execution is enabled by default and requires the current Worker handshake and a live binding. The shared parameter profile is `view-type-parameters-v1`.

Declare shared Tool definitions with `defineViewType`. Each open View provides its own `bindings` through the Preact `View` component or the plain TypeScript View handle. The Observation grants eligible receivers for each Tool and pins their activation. A `view_id` input selects the receiving instance and Runtime uses that instance's handler. Opening several Views of one type still exposes a single Tool definition.

Ordinary parameters retain their business meaning. `refParam` declares top-level Refs to JSON values alongside those fields. The current profile admits multiple and optional Ref fields and arrays of Ref names; absent optional fields stay absent and invalid present fields reject the whole call. Runtime resolves the complete name from granted Ref owners in the invocation's original Observation, checks actual refType and payload Schema, and supplies recursively frozen effectiveInput to authorization and execution. View/Ref identities remain; there is no separate instance-owned Ref Tool or implicit selector.

The App uses internal IDs from resolved Ref values and rechecks existence, parent, state, permissions and file conflicts as applicable. Meaningful paths and text remain ordinary parameters. When one file View closes, Runtime rejects calls to that receiver while other eligible Views can still receive the shared Tool. Releasing an Observation and revoking a receiver's activation are distinct actions.

A valid failure receipt is reported as failed and can carry App-specific recovery facts. A handler that throws or returns an invalid result can finish with `ACTION_OUTCOME_UNKNOWN` in its terminal receipt. At a waiting deadline, `INVOCATION_WAIT_TIMEOUT` directs the Host to query the original invocation. Dispatched work continues to settlement. Use the receipt and the current View to recover. Return concise Tool data and publish current business data in Views. [Invocation and receipt deadlines](runtime-app-interaction.md)

## App lifecycle

`createTUIApp({ app_name, component })` returns the managed factory and advertises `app-lifecycle-v2` by default. A component that owns resources registers cleanup with `useAppLifecycle({ stop?, close? })`; applications without cleanup work do not need to call the hook. There is no lifecycle opt-in config flag.

`stop` is synchronous and `close` may be asynchronous. The Runtime revokes new calls and invokes stop. It retains the active Tool until its terminal result or confirmed Worker exit. Graceful shutdown then flushes persistence and awaits app cleanup. If the Worker grace period expires, the Host terminates the thread and records the unfinished cleanup. Reports track callback completion, actual Worker exit, and Host resource release separately. Callback completion does not prove that arbitrary external processes or resources have ended; the app must wait for and report its own actual cleanup.

A late registration is stopped immediately. Unmount does not discard cleanup already registered. Preact asynchronous effect cleanup is not made awaitable by this API.

See [Runtime shutdown reports](runtime-shutdown.md), the SDK [tool lifecycle guide](../../sdk/docs/tool-lifecycle.md), and the IDE's [current app contract](../../demo-apps/aotui-ide/SCOPED_IDE.md) for integration details.
