# Tool definition, binding and View lifecycle

Declare Tools once with `defineViewTypeTool` and `defineToolSet`. A plain TypeScript App supplies a complete binding map to `createApp`'s `publish`. A Preact App supplies its map to `AppTools`. The two [work-item examples](app-authoring.md) share the same declaration and readonly parameter types.

In a plain App, validation precedes changes to committed Views, Refs, and Tool bindings. A rejected frame keeps the last good snapshot and its View and Tool activation identities. The App enters a degraded state and rejects new dispatch until a valid frame is published. Resubmitting the last good content preserves its identities. Successfully closing the last matching View revokes its activation. Reopening creates new View and activation identities.

## Preact and the binding controller

| Change | Registration / invocation behavior |
|---|---|
| Create static definition/ToolSet/catalog | No App access, handler, owner or registration |
| Construct controller / render AppTools | Validate/capture only; no registry owner or new handler entry |
| Successful synchronous commit | Acquire that App port's sole owner and commit a complete frame |
| Handler-only update while enabled | Keep registration/release handle/activation; later calls use latest committed function |
| Uncommitted or escaping failed render | Candidate cannot execute; it is not a committed handler update |
| Disable | Release this registration and revoke old qualification |
| Re-enable | New identity; old qualification does not revive |
| Zero → one → many matching Views | One type registration; active when a matching View exists, never copied per instance |
| Close last matching View / reopen | Revoke activation / issue a fresh activation under existing Runtime rules |
| ToolSet or port replacement | Direct replacement rejected before Registry mutation; explicitly unmount/remount |
| Registry update failure | This owner fails closed and attempts every own release; other Apps/owners remain intact |
| Release throws / late registration handle | Stay unavailable and retain unconfirmed responsibility for retry; do not claim disposed |
| Confirmed dispose / repeated stale dispose | Clear this owner's resources; cannot release a successor owner |

The controller holds function references, not a frozen or framework-owned business owner. An invocation already awaiting its handler retains that entered function; updates/dispose do not undo business side effects. A second binding owner is rejected even if all its members are disabled. See [AppTools](app-tools.md) for renderer cleanup and bounded diagnostics.

AppTools commits at the renderer's actual commit boundary. Successful observation requires a valid projection after that commit. SDK initialization and renderer cleanup retain unconfirmed disposal responsibility for retry. Fix a cleanup failure and retry through the owning Host lifecycle.

## Managed renderer cleanup and retained Views

A managed renderer revokes its AppTools owners before running application cleanup. This also applies after initialization fails and when every binding is disabled. Application cleanup cannot re-enter an old handler or revive that renderer. Calls that had already entered a handler keep their entered function; cleanup does not undo their business effects.

An application parent cleanup callback can throw and interrupt Preact's child traversal. Tool revocation and completed View/DOM teardown are separate facts: old View registrations or DOM may remain until cleanup succeeds. The renderer preserves the original application error and retains unconfirmed cleanup responsibility. A closed renderer cannot render again, and an exception must not be reported as resourcesReleased.

Fix the application cleanup cause, then retry that renderer's unmount through the owning Host lifecycle. Explicit initialization on the same container or port can also encounter and retry pending cleanup before a successor is admitted. Successful retry must release only the old owner's resources; stale cleanup must not remove a successor tree. This is cleanup retry, not automatic business-operation retry.

## Business rules and results

The App checks explicit business selectors such as filePath against its current open resources, permissions and versions. One FileDetail closing while another stays open leaves the type Tool active; an old call can reach the handler with the closed file's path, which the App must reject. The catalog and enabled flag do not perform that check or replace Host authorization.

| Handler fact | ToolResult |
|---|---|
| Completed | success:true and a concise receipt; update the View for current data |
| Known no side effect on failure | success:false with effects:'none' |
| Known partial side effects | success:false with effects:'partial' and recovery information |
| Failure with unknown effects | success:false without an invented effects guarantee |
| Throw / malformed result / lost reply | Runtime reports the appropriate entered/unknown outcome; no automatic business retry |

## Ref and App cleanup

Use `refParam` in the ViewType definition. Publish JSON values in their owning View with `ref` / `arrayRef` in plain TypeScript or `useDataRef` / `useArrayRef` in Preact. Runtime resolves each supplied address from the granted original Observation, checks the published type and target schema, and supplies deeply readonly data. Multiple, optional and array selections share the complete argument budget. The App checks current business identity, state and permissions before effects. See [Ref parameters](readonly-ref-v2.md).

Applications that own external resources use plain TypeScript `registerCleanup({ stop, close })` or Preact `useAppLifecycle({ stop, close })`. Each callback is optional. The application releases its own processes, files and services. Runtime and SDK release their registrations, observations, renderer and Worker resources. Persistence has its own flush and close contract.

[Migration](migration.md) removes the ordinary Hook and UI return path without a compatibility shell. Changing the SDK author API does not change the Runtime wire or Observation contract.
