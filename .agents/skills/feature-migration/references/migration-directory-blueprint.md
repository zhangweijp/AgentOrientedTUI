# Migration Directory Blueprint

Use this blueprint when building the final migration package.

The top-level directory name is user-configurable. Default to `Migration/`, but honor any explicit name the user requests.

## Required Structure

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

## File Contracts

### `index.md`

Top-level navigation file. It should answer:

- what feature this package covers
- what a reader should read first
- where the copied code lives

### `01-feature-overview.md`

Define the feature boundary:

- purpose
- in-scope behavior
- out-of-scope behavior
- entry points
- source assumptions
- target assumptions

### `02-user-journeys.md`

Describe the journeys that justify the migration:

- success path
- important branch paths
- failures worth preserving

For each journey, name the touched modules and data contracts.

### `03-module-map.md`

Create the architectural decomposition table. This is the document that tells another team what each module is doing and whether it should be copied, adapted, rewritten, or ignored.

Minimum columns:

- migration unit
- module
- role
- responsibility
- inputs
- outputs
- portability
- notes

### `04-data-flow.md`

Show how data moves through the feature. This is where hidden coupling becomes visible.

Minimum content:

- ingress and validation
- transformations and decisions
- persistence reads and writes
- outbound effects
- contract inventory

### `05-migration-plan.md`

Convert understanding into execution. The plan must be ordered and verifiable.

Always include:

- strategy
- prerequisites
- ordered steps
- per-step verification

### `06-risks-and-verification.md`

List migration risks that could cause silent failure or partial behavior drift.

Always include:

- risks and mitigations
- final verification checklist
- contract and failure-path checks

### `code/index.md`

Index all copied code bundles. This is the table of contents for the implementation reference package.

### `code/<bundle-name>/index.md`

This file is mandatory for every copied bundle.

It must explain:

- why the bundle exists
- what role it plays in the feature
- what contracts and dependencies it carries
- what can stay unchanged
- what must change in the target project
- how to verify successful integration

## Bundle Naming

Use names that describe responsibility, not just source folders.

Good examples:

- `message-orchestration`
- `doc-tool-contracts`
- `streaming-renderer`
- `storage-session-state`

Avoid vague names:

- `misc`
- `helpers`
- `src-copy-1`

## Code Selection Rule

Copy the smallest code set that still preserves understanding.

Usually include:

- core implementation
- required types and schemas
- config helpers
- tests and fixtures that prove the contract

Usually exclude unless essential:

- unrelated utilities
- broad framework wrappers with no feature-specific logic
- source-project bootstrapping noise

## Portability Labels

Use one of these labels consistently:

- `portable`
- `adapt`
- `rewrite`
- `exclude`
