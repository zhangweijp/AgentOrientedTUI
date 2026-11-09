# ViewType Tools, Ref parameters, and app cleanup

The supported Worker interaction mode is `view-type-parameters-v1`. The trusted Host selects it through interactionModes; omission enables it, while [] disables execution. Host/Worker negotiation and per-binding qualification remain mandatory. Retired modes are explicitly rejected, not reinterpreted as new calls.

Declare each Tool once per App/ViewType with defineViewTypeTool/defineToolSet, then bind its execute/enabled map through AppTools or createToolBindings. Matching Views activate one shared type Tool; the Observation pins its App instance, descriptor and activation. Opening multiple same-type Views does not duplicate the Tool or choose its business object.

Ordinary parameters retain their business meaning. `refParam` declares top-level object or object-list Refs alongside those fields. This candidate admits multiple and optional Ref fields and arrays of Ref names; absent optional fields stay absent and invalid present fields reject the whole call. Runtime resolves the complete name from granted Ref owners in the invocation's original Observation, checks actual refType and payload Schema, and supplies recursively frozen effectiveInput to authorization and execution. View/Ref identities remain; there is no separate instance-owned Ref Tool or implicit selector.

Ref data being readonly does not restrict App business effects. The App uses internal IDs from the resolved value and rechecks existence, parent/state/permission or file conflicts. Meaningful paths/text remain ordinary parameters. If one file closes while another same-type View remains active, the shared Tool may still reach the App; its guard must reject a closed business target. Releasing an Observation and revoking a type activation are distinct actions.

A failure may declare effects:none or partial only when the App knows that fact. Omitted effects, thrown handlers or lost responses do not prove that no business effect occurred. Closing a Scope or aborting a waiter does not undo work. Runtime does not retry unknown writes. Return a short receipt and put current data in Views; handler completion is distinct from projection publication.

## App lifecycle

`createTUIApp({ app_name, component })` returns the managed factory and advertises `app-lifecycle-v2` by default. A component that owns resources registers cleanup with `useAppLifecycle({ stop?, close? })`; applications without cleanup work do not need to call the hook. There is no lifecycle opt-in config flag.

`stop` is synchronous and `close` may be asynchronous. The Runtime revokes new calls and begins managed persistence handling before it awaits app cleanup. It then disposes framework resources and keeps separate reports for callback completion and Runtime-owned resource release. Callback completion does not prove that arbitrary external processes or resources have ended; the app must wait for and report its own actual cleanup.

A late registration is stopped immediately. Unmount does not discard cleanup already registered. Preact asynchronous effect cleanup is not made awaitable by this API.

See [Runtime shutdown reports](runtime-shutdown.md), the SDK [tool lifecycle guide](../../sdk/docs/tool-lifecycle.md), and the IDE's [current app contract](../../demo-apps/aotui-ide/SCOPED_IDE.md) for integration details.
