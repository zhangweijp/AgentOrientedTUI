#!/usr/bin/env python3
"""
Initialize a migration package directory for a feature migration package.
"""

from __future__ import annotations

import argparse
from pathlib import Path


TEMPLATES = {
    "index.md": """# {{FEATURE_NAME}} Migration Package

> Purpose: Help another team migrate `{{FEATURE_NAME}}` into a different project with minimal hidden assumptions.

## Package Contents

- [01-feature-overview.md](01-feature-overview.md)
- [02-user-journeys.md](02-user-journeys.md)
- [03-module-map.md](03-module-map.md)
- [04-data-flow.md](04-data-flow.md)
- [05-migration-plan.md](05-migration-plan.md)
- [06-risks-and-verification.md](06-risks-and-verification.md)
- [code/index.md](code/index.md)

## Reading Order

1. Read the feature overview to understand scope and non-goals.
2. Read the journeys and data flow to understand behavior.
3. Read the module map to understand source boundaries.
4. Read the migration plan before copying or rewriting anything.
5. Use `code/` as the implementation reference package.
""",
    "01-feature-overview.md": """# Feature Overview

## Purpose

Describe the user value created by `{{FEATURE_NAME}}`.

## In Scope

- TODO

## Out of Scope

- TODO

## Entry Points

- TODO

## Source Project Assumptions

- TODO

## Target Project Assumptions

- TODO
""",
    "02-user-journeys.md": """# User Journeys

## Journey Template

### Journey: <name>

- Actor:
- Trigger:
- Preconditions:
- Modules touched:
- Data consumed:
- Data produced:
- User-visible result:
- Failure behavior:

## Journeys

### Journey: Primary success path

- Actor:
- Trigger:
- Preconditions:
- Modules touched:
- Data consumed:
- Data produced:
- User-visible result:
- Failure behavior:
""",
    "03-module-map.md": """# Module Map

## Role Labels

- `entrypoint`
- `orchestrator`
- `domain`
- `adapter`
- `persistence`
- `contract`
- `presentation`
- `policy`
- `observability`
- `test-support`

## Modules

| Migration Unit | Module | Role | Responsibility | Inputs | Outputs | Portability | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
""",
    "04-data-flow.md": """# Data Flow

## End-to-End Flow

Document the full path:

1. ingress
2. normalization
3. decision
4. persistence
5. outbound effects
6. rendered or returned result

## Contract Inventory

| Contract | Kind | Produced By | Consumed By | Notes |
| --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO |
""",
    "05-migration-plan.md": """# Migration Plan

## Strategy

State whether the migration is copy-first, rewrite-first, or hybrid.

## Ordered Steps

1. TODO
2. TODO
3. TODO

## Per-Step Verification

| Step | Verification | Exit Criteria |
| --- | --- | --- |
| TODO | TODO | TODO |
""",
    "06-risks-and-verification.md": """# Risks And Verification

## Risks

| Risk | Why It Matters | Mitigation |
| --- | --- | --- |
| TODO | TODO | TODO |

## Verification Checklist

- TODO: contract tests copied or rewritten
- TODO: config keys mapped
- TODO: source-coupled infrastructure replaced
- TODO: primary user journey passes
- TODO: failure path verified
""",
    "code/index.md": """# Code Bundle Index

List the copied migration bundles here.

| Bundle | Purpose | Portability | Notes |
| --- | --- | --- | --- |
| TODO | TODO | TODO | TODO |
""",
    "code/_bundle-template/index.md": """# Bundle Guide

## Why This Bundle Exists

Describe the responsibility this bundle owns inside `{{FEATURE_NAME}}`.

## Included Files

- TODO

## Source Origins

- TODO

## Contracts

- Inputs:
- Outputs:
- Config:
- Storage:
- Events:

## Dependencies

- Upstream:
- Downstream:
- External systems:

## Migration Guidance

- Can stay unchanged:
- Must be adapted:
- Can be rewritten cleanly:

## Verification

- TODO
""",
}


def render(template: str, feature_name: str) -> str:
    return template.replace("{{FEATURE_NAME}}", feature_name)


def write_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def init_directory(output_dir: Path, feature_name: str, force: bool) -> None:
    if output_dir.exists() and any(output_dir.iterdir()) and not force:
        raise SystemExit(
            f"Refusing to write into non-empty directory: {output_dir}. "
            "Use --force if you want to overwrite template files."
        )

    for relative_path, template in TEMPLATES.items():
        destination = output_dir / relative_path
        if destination.exists() and not force:
            continue
        write_file(destination, render(template, feature_name))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a migration package directory scaffold.")
    parser.add_argument(
        "output_dir",
        help="Path to the migration package directory to create, for example ./Migration or ./Feishu-Migration",
    )
    parser.add_argument("--feature", required=True, help="Human-readable feature name")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite template files when they already exist",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    init_directory(Path(args.output_dir).resolve(), args.feature.strip(), args.force)
    print(f"Initialized migration scaffold at {Path(args.output_dir).resolve()}")


if __name__ == "__main__":
    main()
