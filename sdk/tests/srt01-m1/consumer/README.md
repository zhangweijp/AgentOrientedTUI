# SRT-01 M1/M2 installed-package consumer

This directory is the single retained M1 static consumer, extended with M2 bindings. Its historical directory name is not a package identity. All runtime imports use public SDK/Runtime exports. Replace the three @aotui dependencies with the candidate SDK and accepted Runtime/Driver tar files in a fresh directory; add matching root pnpm overrides so transitive packages resolve to those same tars. Keep both pinned TypeScript compilers and peer dependencies.

Run `node /path/to/verify.mjs /absolute/consumer` after installation. The verifier records full commands, exit codes and diagnostics under results/, checks both strict compilers, emits the cross-module runtime fixture, runs the retained static contracts and the real Registry binding suite, then starts a separate /tools-only process. That process checks module resolution and load graphs while exercising the complete binding lifecycle. Root/tools brand and owner tests intentionally import the Preact root entry in the separate binding test process.

Negative inputs compile individually and must fail for the intended contract, without missing-module diagnostics. No source paths, aliases or workspace symlinks are used. Preact remains an installed SDK peer; DOM ambient types remain enabled for declarations. This is M1/M2 package verification, not M3 JSX or full Worker/IDE validation.

M2.2 also verifies invariant controller declaration maps: direct variable, cross-module handoff and object-spread conversion to a different Schema are rejected. The reverse controller conversion is intentionally rejected too. Same-map handoff and safely broader handler functions remain supported. New negatives compile independently in both pinned compilers.
