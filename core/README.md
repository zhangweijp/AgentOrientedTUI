# @aotui/core

Core provides the shared App factory contract and the executable rules for complete View projections, Tool parameters, Ref values, observations and calls. Use `@aotui/sdk` to author an App and `@aotui/runtime` to host it in a managed Worker. Both consume this package.

For a custom host, `createSnapshotCore` owns an App instance's committed snapshots. Use `SemanticProjectionCoordinator` to prepare and publish complete frames, then use `createAppInteraction` with an explicit policy and execution binding. For a Desktop with multiple Apps, use one `createTurnCoordinator()`. Prepare each candidate with its interaction and live-instance check, adopt the complete selected list once, and dispatch through the returned turn. A rejected adoption preserves the previous live selection. For a standalone App, the interaction's adoption convenience uses the same observation validation. The execution port still checks the selected View and Tool binding. [Complete Core example](examples/public-core.ts)

When assembling an App directly, bind `RuntimeContext.readPreparedViewId: (type, name) => projection.readPreparedViewId(type, name)` to the same coordinator as `publishFrame`. Preact also needs `readPreparedProjection: () => projection.readPreparedProjection()` to read the healthy frame's local version when rendering is skipped. Plain TypeScript factories supply complete candidate frames through `publishFrame`.

Tool and Ref value declarations are bounded plain JSON Schema 2020-12 objects in the supported AOTUI profile. A Tool schema has an object root. `{}` accepts bounded JSON in business fields, including array items and nested properties. A declared Ref or `refParam` value schema requires a concrete root rule. Declare a fixed tuple with `prefixItems`, `items: false` and a matching `minItems`. An empty tuple omits `prefixItems`. Core compiles admitted rules with `typebox/schema` from TypeBox 1.4.3 and reuses them for calls. Model addresses resolve against the original observation before the resolved JSON undergoes the same business validation.

Core's public types work with the ES2022 standard library. The four entries are:

- `@aotui/core` supplies shared contracts, schema validators, Ref capture and projection-limit configuration.
- `@aotui/core/producer` provides frame coordination and View-owned tool registration through `SemanticProjectionCoordinator`, `commitAppFrame` and `createViewOwnedTools`.
- `@aotui/core/host` provides snapshot storage, observation, Ref resolution and invocation. Use its `hostedObservationCapacityIssue` to check the shared business observation before accepting a managed opening. Each Host adapter checks the size of its own Tool projection.
- `@aotui/core/persistence` provides `createStateSession`, which accepts a supplied `StateStorage`. Work at the same address follows admission order. A flush waits for the queued, active and retained mutation results it captured.

The managed Runtime owns namespaces, Workers, transport and concrete storage backends.
