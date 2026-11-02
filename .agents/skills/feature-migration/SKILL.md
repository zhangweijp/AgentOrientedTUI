---
name: feature-migration
description: Use when migrating a feature or subsystem from one codebase into another, especially when the source behavior spans multiple modules, user journeys, data flows, configs, and tests that another team must understand before copying or reimplementing it.
---

# Feature Migration

## Overview

Produce a migration package that lets an unfamiliar team move one feature into another project without guessing hidden contracts. Treat the migration output as an execution guide, not a research diary.

## Required Outcome

Always leave behind a migration package directory, defaulting to `Migration/` unless the user requests a different name, that does all of the following:

1. Explains what the feature is and where its boundary starts and ends
2. Maps the modules involved and the role each module plays
3. Describes the user journeys and data flow end to end
4. Separates portable code from coupled code and explains why
5. Copies the relevant source files into `Migration/code/`
6. Adds an `index.md` beside every copied code bundle
7. Gives a concrete migration order, risk list, and verification plan

If the output would not let a new team migrate the feature with confidence, it is incomplete.

## When To Ask Questions

Default to action. Ask a question only when one missing fact would materially change the migration package.

Ask at most one question, and make it the highest-leverage one. Typical examples:

- what exact feature boundary to migrate
- what target project or target stack receives the feature
- whether the goal is code transplantation, clean-room reimplementation, or hybrid migration

## Workflow

### 1. Frame the feature boundary

Start by naming the feature in terms of user value, not files.

Capture:

- feature purpose
- primary actors
- entry points
- success result
- explicit non-goals

Do not start by copying files. First decide what behavior belongs to the feature and what only happens to sit nearby.

### 2. Build the feature surface map

Trace the full implementation surface before producing any migration guidance.

Look for:

- UI entry points, API handlers, CLI commands, background jobs, hooks
- orchestrators that coordinate multiple modules
- domain services and policy modules
- adapters for storage, network, auth, queue, analytics, notifications
- types, schemas, config, feature flags, environment variables
- tests, fixtures, mocks, and sample data

Classify each discovered module with one primary role:

- entrypoint
- orchestrator
- domain
- adapter
- persistence
- contract
- presentation
- policy
- observability
- test-support

Use this classification consistently in the migration docs.

### 3. Analyze user journeys before module extraction

For every meaningful journey, describe the runtime path from trigger to completion.

For each journey capture:

- actor and trigger
- preconditions
- step-by-step system behavior
- modules touched in order
- data read, produced, transformed, persisted, and emitted
- failure points and fallback behavior
- user-visible output

Prefer a small set of complete journeys over a large set of shallow bullets.

### 4. Trace the data flow

Document how data moves across boundaries, not just which files exist.

Always identify:

- input shape
- normalization or validation
- internal state transitions
- persistence writes and reads
- outbound side effects
- return payloads or rendered output

Name the contracts precisely: types, schemas, DTOs, event payloads, config keys, and storage records.

### 5. Cut migration units

Split the feature into migration units that another team can reason about independently.

Good migration units are:

- cohesive
- bounded by a clear responsibility
- transplantable or rewriteable as one decision
- understandable without opening unrelated internals

For every unit, assign one portability label:

- `portable`: can usually be copied with shallow adaptation
- `adapt`: core logic is reusable but integration seams must change
- `rewrite`: behavior matters, implementation is too source-coupled
- `exclude`: adjacent but not required for this feature migration

### 6. Produce the Migration directory

Create a top-level migration package directory in the workspace or in the user-requested location.

Use `scripts/init_migration_dir.py` to scaffold it, or reproduce the same structure manually. Default to `Migration/`, but honor a user-specified directory name. The directory contract lives in `references/migration-directory-blueprint.md`.

Write the migration documents using the style rules in `references/migration-writing-rules.md`.

### 7. Copy code only after the architecture is understood

Copy only code that materially helps the target team migrate the feature:

- core implementation
- contracts and schemas
- required configuration helpers
- test files that prove behavior
- fixtures or sample payloads when they clarify contracts

Do not dump an entire subtree just because it was nearby.

Inside `Migration/code/`, group copied files by migration unit. Every bundle must include an `index.md` that explains:

- why this bundle exists
- what role it plays in the feature
- what contracts it exposes
- what it depends on
- what can stay unchanged
- what must be adapted in the target project
- how to integrate and verify it

### 8. Write the migration plan as executable guidance

The migration plan must be ordered. It is not enough to describe the system.

Always specify:

1. prerequisites and target assumptions
2. recommended integration sequence
3. per-step changes required in the target project
4. risks, unknowns, and source-coupled parts
5. validation checks after each milestone

When in doubt, bias toward sequence and decision criteria.

## Migration Directory Contract

Use this shape unless the user has a better existing convention or requests a different top-level directory name:

```text
<migration-dir>/
├── index.md
├── 01-feature-overview.md
├── 02-user-journeys.md
├── 03-module-map.md
├── 04-data-flow.md
├── 05-migration-plan.md
├── 06-risks-and-verification.md
└── code/
    ├── index.md
    └── <bundle-name>/
        ├── index.md
        └── copied source files...
```

For the detailed document contract, read `references/migration-directory-blueprint.md`.

## Writing Standard

Write every migration document so it behaves like a good skill:

- lead with purpose and trigger
- make boundaries explicit
- prefer decisions and consequences over vague summaries
- keep sections skimmable
- explain why a module exists before diving into internals
- document contracts and invariants, not only code names
- avoid source-repo assumptions that the reader cannot see

Treat every `index.md` as a local guide for a future agent or engineer who has not read the rest of the package.

## Red Flags

Stop and fix the package if any of these are true:

- the report lists files but never explains user value
- modules are copied without role, boundary, or dependency notes
- journeys are described without naming touched modules
- data flow is implied but not written down
- the migration plan says “adapt as needed”
- copied code has no `index.md`
- tests exist in the source repo but are absent from the migration package without explanation
- infrastructure-coupled code is labeled reusable without caveats

## Quality Gate

Before finishing, check whether a new team could answer these questions from the migration package directory alone:

1. What exactly is the feature, and what is out of scope?
2. Which modules are essential, optional, or source-coupled?
3. How does a user trigger the feature and what happens next?
4. Which data contracts must exist in the target project?
5. In what order should the migration be performed?
6. How will the team know the migration is complete and correct?

If any answer depends on tribal knowledge, revise the package.

## Quick Start

1. Identify the feature boundary and target migration style.
2. Analyze source code until journeys, modules, and data flow are clear.
3. Run `python3 scripts/init_migration_dir.py <output-dir> --feature "<feature-name>"`.
4. Fill the scaffolded docs with concrete findings.
5. Copy the selected code bundles into `Migration/code/`.
6. Write or update each bundle `index.md`.
7. Verify the package against the quality gate above.
