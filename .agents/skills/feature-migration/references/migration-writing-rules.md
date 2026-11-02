# Migration Writing Rules

Write migration documents the way a strong skill is written: minimal ambiguity, clear triggers, explicit decisions, and low reader guesswork.

## Core Principles

### 1. Lead with purpose

Start each document and bundle guide by stating why it exists.

Bad:

`This folder contains several files copied from src/reply.`

Good:

`This bundle owns the reply orchestration logic that turns model output into channel-specific outbound messages.`

### 2. Prefer boundaries over descriptions

A migration reader needs to know where responsibility starts and ends.

Always make clear:

- what the module owns
- what it depends on
- what it explicitly does not own

### 3. Write for a cold reader

Assume the reader has not opened the source repo and does not know the original architecture. Expand local jargon the first time it appears.

### 4. Document contracts, not just filenames

Name concrete contracts:

- types
- schemas
- storage records
- event payloads
- environment variables
- feature flags

### 5. Explain change pressure

For every migration unit, tell the reader whether it is:

- stable and mostly copyable
- reusable but integration-coupled
- behaviorally important but implementation-coupled

This is what allows a target team to choose transplant versus rewrite.

### 6. Keep prose executable

Avoid generic advice such as:

- “adapt to your project”
- “wire things up”
- “update related code”

Replace them with concrete statements:

- which seam changes
- which dependency must be swapped
- which contract must be preserved
- which test should pass afterward

## Suggested Section Pattern

For top-level docs:

1. purpose
2. scope
3. structure or inventory
4. decisions
5. consequences

For bundle `index.md` files:

1. why this bundle exists
2. included files
3. source origins
4. contracts
5. dependencies
6. migration guidance
7. verification

## Red Flags

Revise the document if it:

- reads like a research log
- repeats folder names without interpretation
- hides key decisions in long paragraphs
- depends on “obvious” source context
- never states what must remain behaviorally identical

