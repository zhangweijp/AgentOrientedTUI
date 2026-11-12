# Observe the committed application projection

`AppInteraction.observe(selection)` prepares a candidate observation. For a Worker App, the
Host first asks that App's Worker to flush its already queued renderer commits.
The Worker sends a correlated Snapshot; the Host validates and accepts it before
the instance captures View, Ref and Tool data. A notification is not an acknowledgement
and is not required for correctness. `signalPolicy: 'never'` still permits a fresh
observation. An unchanged Snapshot can retain its existing content identity.

For an ordinary TypeScript Producer, publish the completed View/Ref/Tool frame
through the shared projection coordinator before observing it. This does not wait
for background business tasks, reread files or infer application dependencies.

The managed SDK joins Preact's actual queued render callback. It preserves the
configured Preact scheduling function instead of guessing how many microtasks or
milliseconds rendering takes. `AppInstance.whenCommitted(signal)` is the
optional adapter completion hook; a synchronous renderer may omit it. Custom
asynchronous renderers must provide completion for work they have already queued.

Business completion and observation completion remain separate facts. A trusted
Tool result is retained if the new projection fails. The next observation returns
a projection error rather than presenting the old frame as the new result. Repair
the application's state and observe again; do not replay a successful business
operation to repair its projection.

Each App owns at most one Worker refresh in flight. A refresh timeout reports
`PROJECTION_TIMEOUT` but keeps that slot until the real response or App close;
retries do not accumulate Worker waits. `preview()` shares the same refresh
and returns committed Views without reserving an observation. Each instance holds
its adopted observation and at most one candidate. Adopting the candidate revokes
the previous calling qualification. App close cancels renderer waits and retires
the Host request. See [instance interaction](runtime-app-interaction.md).
