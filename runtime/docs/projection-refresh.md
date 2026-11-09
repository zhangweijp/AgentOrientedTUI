# Observe the committed application projection

`ScopeClient.observe(selection)` retains its existing API. For a Worker App, the
Host first asks that App's Worker to flush its already queued renderer commits.
The Worker sends a correlated Snapshot; the Host validates and accepts it before
the Scope captures View, Ref and Tool data. A notification is not an acknowledgement
and is not required for correctness. `signalPolicy: 'never'` still permits a fresh
observation. An unchanged Snapshot can retain its existing content identity.

For an ordinary TypeScript Producer, publish the completed View/Ref/Tool frame
through the existing Snapshot committer before observing it. This does not wait
for background business tasks, reread files or infer application dependencies.

The managed SDK joins Preact's actual queued render callback. It preserves the
configured Preact scheduling function instead of guessing how many microtasks or
milliseconds rendering takes. `ComponentRenderer.whenCommitted(signal)` is the
optional adapter completion hook; a synchronous renderer may omit it. Custom
asynchronous renderers must provide completion for work they have already queued.

Business completion and observation completion remain separate facts. A trusted
Tool result is retained if the new projection fails. The next observation returns
a projection error rather than presenting the old frame as the new result. Repair
the application's state and observe again; do not replay a successful business
operation to repair its projection.

Each App owns at most one Worker refresh in flight. A refresh timeout reports
`PROJECTION_TIMEOUT` but keeps that slot until the real response or App close;
retries do not accumulate Worker waits. A Scope admits one observation at a time
and rejects overlap with `OBSERVATION_BUSY`. Closing that Scope ends its waiting
caller without cancelling other Scopes' shared App refresh. App close cancels the
renderer/commit wait and clears the Host request. Existing Snapshot, observation
and invocation budgets remain in effect.

This change does not adopt an observation, revoke a preceding observation, retain
a cross-turn current Context, or change historical Snapshot retention. Those
contracts remain separate work under SRT-05. Scope/Source/Driver entry points are
unchanged.
