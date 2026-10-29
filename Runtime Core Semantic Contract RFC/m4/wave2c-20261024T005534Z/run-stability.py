import pathlib
import subprocess
import sys

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
runner = directory / 'run-check.py'
prefix = sys.argv[1] if len(sys.argv) > 1 else ''
files = [
    'src/core/tool/ref-declarations.wave2c.test.ts',
    'src/core/tool/source-binding.test.ts',
    'src/core/tool/source-binding.wave2a.test.ts',
    'src/core/snapshot/ref-contract.wave2b.test.ts',
    'src/engine/app/worker-host.wave2c-declarations.test.ts',
    'src/engine/app/worker-host.wave2a-readonly.test.ts',
    'src/engine/app/worker-host.wave2a-request.test.ts',
    'src/engine/app/worker-host.r1-terminal-race.test.ts',
    'src/engine/app/worker-host.m4-lifecycle.test.ts',
    'src/engine/app/worker-host.m4-readonly.test.ts',
    'src/engine/app/worker-host.m4-versioned-file.test.ts',
    'src/engine/app/worker-host.m4-producer-race.test.ts',
]
commands = [
    ('stability-' + str(n), ['pnpm', '--dir', 'runtime', 'exec', 'vitest', 'run', *files, '--reporter=dot'])
    for n in range(1, 4)
]
review = 'Runtime Core Semantic Contract RFC/m4/stage8/independent-review-20261023-01/'
commands += [
    ('r1-original-real-worker', ['node', review + 'lifecycle-terminal-race-real-worker.mjs']),
    ('r1-original-controlled', ['node', review + 'lifecycle-terminal-race.mjs']),
]
codes = []
for name, command in commands:
    codes.append(subprocess.run([sys.executable, str(runner), prefix + name, *command], cwd=root).returncode)
sys.exit(int(any(codes)))
