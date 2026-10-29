#!/bin/zsh
# M0 reproducible code probes. Does not overwrite tracked source.
# Temporarily copies OWN generated tests into sdk/src and runtime/src for proper
# Vitest module resolution, then cleans them in a verified trap.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2
M0="Runtime Core Semantic Contract RFC/m0"
clean() {
  python3 - <<'PY'
from pathlib import Path
files=[
 Path('sdk/src/__m0_projection_probe.test.ts'),
 Path('sdk/src/__m0_appkernel_probe.test.ts'),
 Path('sdk/src/__m0_coordinator_poc.test.ts'),
 Path('runtime/src/__m0_runtime_probe.test.ts'),
 Path('runtime/src/__m0_formatter_bench.test.ts'),
]
for path in files:
 if path.exists():
  data=path.read_text()
  if data.startswith('/**\n * M0 '):
   path.unlink()
   print('TEMP_REMOVED',path)
  else:
   print('UNRECOGNIZED_TEMP_LEFT_UNTOUCHED',path)
PY
}
trap clean EXIT
python3 - <<'PY'
from pathlib import Path
base=Path('Runtime Core Semantic Contract RFC/m0/probes')
mapping={
 'sdk-projection.test.ts': 'sdk/src/__m0_projection_probe.test.ts',
 'sdk-appkernel.test.ts': 'sdk/src/__m0_appkernel_probe.test.ts',
 'coordinator-poc.test.ts': 'sdk/src/__m0_coordinator_poc.test.ts',
 'runtime-observation.test.ts': 'runtime/src/__m0_runtime_probe.test.ts',
 'formatter-benchmark.test.ts': 'runtime/src/__m0_formatter_bench.test.ts',
}
for source,target in mapping.items():
 dest=Path(target)
 if dest.exists():raise FileExistsError('Refuse overwriting '+target)
for source,target in mapping.items():
 text=(base/source).read_text()
 if target.startswith('sdk/'):
  text=text.replace("../../../sdk/node_modules/preact/dist/preact.module.js","preact")
  text=text.replace("../../../sdk/node_modules/preact/hooks/dist/hooks.module.js","preact/hooks")
  text=text.replace("../../../sdk/src/","./")
  text=text.replace("../../../runtime/src/","../../runtime/src/")
 else:
  text=text.replace("../../../runtime/src/","./")
 dest=Path(target)
 dest.write_text(text)
 print('TEMP_CREATED',dest)
PY

echo "HEAD=$(git rev-parse --short HEAD) NODE=$(node -v) PNPM=$(pnpm -v)"
echo "M0 SDK probes:"
pnpm --dir sdk exec vitest run \
  src/__m0_projection_probe.test.ts \
  src/__m0_appkernel_probe.test.ts \
  src/__m0_coordinator_poc.test.ts --reporter=verbose > "$M0/sdk-probes-rerun.log" 2>&1
SDK_CODE=$?
echo "SDK_PROBE_EXIT=$SDK_CODE"
grep -E 'Test Files|Tests  |M0_SP01_TIMELINE|M0_REAL_APPKERNEL_|M0_SP02_COORDINATOR_POC' "$M0/sdk-probes-rerun.log" | cut -c 1-350

echo "M0 Runtime probes:"
pnpm --dir runtime exec vitest run \
  src/__m0_runtime_probe.test.ts \
  src/__m0_formatter_bench.test.ts --reporter=verbose > "$M0/runtime-probes-rerun.log" 2>&1
RUNTIME_CODE=$?
echo "RUNTIME_PROBE_EXIT=$RUNTIME_CODE"
grep -E 'Test Files|Tests  |M0_(SNAPSHOT_STORE|WORKER_TIMESTAMP|REF_FALLBACK|TOOL_RESULT|SP05_SPLIT_REF|SP04_REAL_IPC|SP06_WORKSPACE_COMPOSITE|SP07_PROJECTION_PERF)' "$M0/runtime-probes-rerun.log" | cut -c 1-350

node "$M0/probes/source-inventory.cjs" > "$M0/source-inventory.json"
SCAN_CODE=$?
node "$M0/probes/ref-wire-compat.cjs" > "$M0/ref-wire-compat.json"
SERIAL_CODE=$?
echo "SCAN_EXIT=$SCAN_CODE SERIAL_EXIT=$SERIAL_CODE"
if (( SDK_CODE != 0 || RUNTIME_CODE != 0 || SCAN_CODE != 0 || SERIAL_CODE != 0 )); then
  echo "M0_PROBES_FAILED: inspect logs in $M0"
  exit 1
fi
echo "M0_PROBES_PASS: probes confirm current behavior; NOT a passing target Core contract."
