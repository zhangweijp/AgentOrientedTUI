#!/usr/bin/env python3
"""Capture code hashes for M0 worktree reproducibility. Do not read Markdown."""
from pathlib import Path
from hashlib import sha256
import json
import subprocess

code_files = [
    "sdk/src/hooks/useRef.ts",
    "sdk/src/hooks/useArrayRef.ts",
    "sdk/src/hooks/useViewTypeTool.ts",
    "sdk/src/components/View.tsx",
    "sdk/src/app-factory/createTUIApp.ts",
    "sdk/src/contexts/view-runtime-context.ts",
    "runtime/src/worker-runtime/app-kernel/AppKernel.ts",
    "runtime/src/worker-runtime/index.ts",
    "runtime/src/worker-runtime/view-fragment-extractor.ts",
    "runtime/src/engine/app/worker-host.ts",
    "runtime/src/engine/system/registry.ts",
    "runtime/src/engine/view/snapshot/formatter.ts",
    "runtime/src/engine/view/transformer/pure.ts",
    "runtime/src/engine/system/dispatcher.ts",
    "runtime/src/kernel/index.ts",
    "runtime/src/spi/worker-protocol/messages.ts",
    "demo-apps/planning-app/src/types.ts",
    "demo-apps/terminal-app/src/types.ts",
    "demo-apps/lite-browser-app/src/types.ts",
    "experiments/semantic-kernel/src/contracts.ts",
    "experiments/semantic-kernel/src/kernel.ts",
    "experiments/semantic-kernel/test/kernel.test.ts",
]
probes = [
    "Runtime Core Semantic Contract RFC/m0/probes/sdk-projection.test.ts",
    "Runtime Core Semantic Contract RFC/m0/probes/sdk-appkernel.test.ts",
    "Runtime Core Semantic Contract RFC/m0/probes/coordinator-poc.test.ts",
    "Runtime Core Semantic Contract RFC/m0/probes/runtime-observation.test.ts",
    "Runtime Core Semantic Contract RFC/m0/probes/formatter-benchmark.test.ts",
    "Runtime Core Semantic Contract RFC/m0/probes/ref-wire-compat.cjs",
    "Runtime Core Semantic Contract RFC/m0/probes/source-inventory.cjs",
    "Runtime Core Semantic Contract RFC/m0/run-probes.sh",
]
def run(*command):
    return subprocess.check_output(command, text=True).strip()
def digest(path: str):
    data = Path(path).read_bytes()
    return {"sha256": sha256(data).hexdigest(), "bytes": len(data)}
record = {
    "head": run("git", "rev-parse", "HEAD"),
    "node": run("node", "--version"),
    "pnpm": run("pnpm", "--version"),
    "gitStatusCount": len(run("git", "status", "--short").splitlines()),
    "files": {path: digest(path) for path in code_files},
    "probes": {path: digest(path) for path in probes},
}
print(json.dumps(record, indent=2, sort_keys=True))
