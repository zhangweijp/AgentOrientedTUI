# ViewType Tools, Ref parameters, and app cleanup

The trusted Host can set `toolsEnabled: false` for read-only observation. Tool execution is enabled by default and requires the current Worker handshake and a live binding. The shared parameter profile is `view-type-parameters-v1`.

Declare each Tool once per App/ViewType with defineViewTypeTool/defineToolSet, then bind its execute/enabled map through AppTools or createToolBindings. Matching Views activate one shared type Tool; the Observation pins its App instance, descriptor and activation. Opening multiple same-type Views does not duplicate the Tool or choose its business object.

Ordinary parameters retain their business meaning. `refParam` declares top-level Refs to JSON values alongside those fields. The current profile admits multiple and optional Ref fields and arrays of Ref names; absent optional fields stay absent and invalid present fields reject the whole call. Runtime resolves the complete name from granted Ref owners in the invocation's original Observation, checks actual refType and payload Schema, and supplies recursively frozen effectiveInput to authorization and execution. View/Ref identities remain; there is no separate instance-owned Ref Tool or implicit selector.

Ref data being readonly does not restrict App business effects. The App uses internal IDs from the resolved value and rechecks existence, parent/state/permission or file conflicts. Meaningful paths/text remain ordinary parameters. If one file closes while another same-type View remains active, the shared Tool may still reach the App; its guard must reject a closed business target. Releasing an Observation and revoking a type activation are distinct actions.

A normal, valid failure receipt is reported as failed. The receipt can carry App-specific recovery facts. A handler that throws or returns an invalid result finishes with an unknown outcome. A waiting deadline can also yield an interim unknown outcome while dispatched work remains active. Use the existing receipt and current View to recover. Return concise Tool data and publish current business data in Views.

## App lifecycle

`createTUIApp({ app_name, component })` returns the managed factory and advertises `app-lifecycle-v2` by default. A component that owns resources registers cleanup with `useAppLifecycle({ stop?, close? })`; applications without cleanup work do not need to call the hook. There is no lifecycle opt-in config flag.

`stop` is synchronous and `close` may be asynchronous. The Runtime revokes new calls and invokes stop. It retains the active Tool until its terminal result or confirmed Worker exit. Graceful shutdown then flushes persistence and awaits app cleanup. If the Worker grace period expires, the Host terminates the thread and records the unfinished cleanup. Reports track callback completion, actual Worker exit, and Host resource release separately. Callback completion does not prove that arbitrary external processes or resources have ended; the app must wait for and report its own actual cleanup.

A late registration is stopped immediately. Unmount does not discard cleanup already registered. Preact asynchronous effect cleanup is not made awaitable by this API.

See [Runtime shutdown reports](runtime-shutdown.md), the SDK [tool lifecycle guide](../../sdk/docs/tool-lifecycle.md), and the IDE's [current app contract](../../demo-apps/aotui-ide/SCOPED_IDE.md) for integration details.
