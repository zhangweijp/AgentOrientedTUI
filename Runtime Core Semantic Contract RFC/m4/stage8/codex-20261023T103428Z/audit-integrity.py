import hashlib
import json
import pathlib
import shlex
import subprocess
import sys

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[3]
baseline = json.loads((directory / 'baseline.json').read_text())


def run(command):
    print('COMMAND: ' + shlex.join(command), flush=True)
    result = subprocess.run(command, cwd=root, capture_output=True)
    print(result.stdout.decode(), end='', flush=True)
    print(result.stderr.decode(), end='', flush=True)
    print('EXIT_CODE: ' + str(result.returncode), flush=True)
    if result.returncode:
        sys.exit(result.returncode)
    return result.stdout


head = run(['git', 'rev-parse', 'HEAD']).decode().strip()
status = run(['git', 'status', '--porcelain=v1']).decode()
(directory / 'final-status.log').write_text(status)
index = subprocess.check_output(['git', 'diff', '--cached', '--binary'], cwd=root)
print('COMMAND: git diff --cached --binary | shasum -a 256', flush=True)
index_hash = subprocess.run(['shasum', '-a', '256'], input=index, capture_output=True, check=True).stdout.decode().split()[0]
print(index_hash, flush=True)
worktree = subprocess.check_output(['git', 'diff', '--binary'], cwd=root)
print('COMMAND: git diff --binary | shasum -a 256', flush=True)
worktree_hash = subprocess.run(['shasum', '-a', '256'], input=worktree, capture_output=True, check=True).stdout.decode().split()[0]
print(worktree_hash, flush=True)
node = run(['node', '--version']).decode().strip()
pnpm = run(['pnpm', '--version']).decode().strip()
run(['pnpm', '--dir', 'runtime', 'exec', 'vitest', '--version'])
run(['pnpm', '--dir', 'runtime', 'exec', 'node', '--version'])
allowed = {
    'runtime/src/engine/app/worker-host.ts',
    'runtime/src/engine/app/worker-host.m4-lifecycle.test.ts',
    'runtime/src/engine/app/worker-host.m4-versioned-file.test.ts',
    'runtime/src/core/tool/versioned-file-integration.test.ts',
}
changed = []
for name, record in baseline['files'].items():
    path = root / name
    current = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    if current != record['sha256']:
        changed.append({'path': name, 'baselineSha256': record['sha256'], 'finalSha256': current})
unexpected = [item for item in changed if item['path'] not in allowed]
current_paths = set(subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')) - {''}
new_paths = sorted(current_paths - set(baseline['files']))
report_names = {'CODEX_RESULTS.md', 'GATE_STATUS.json', 'source-fingerprints.json', 'NEXT_WAVE_RECOMMENDATION.md'}
stage = 'Runtime Core Semantic Contract RFC/m4/stage8/'
unexpected_new = [name for name in new_paths if not (
    name.startswith(stage + directory.name + '/') or
    name in {stage + report for report in report_names} or
    name == 'runtime/src/engine/app/worker-host.m4-stage8-outcome.test.ts'
)]
result = {
    'head': head,
    'baselineIndexSha256': baseline['baselineIndexSha256'],
    'finalIndexSha256': index_hash,
    'indexUnchanged': index_hash == baseline['baselineIndexSha256'],
    'baselineWorktreeDiffSha256': baseline['baselineWorktreeDiffSha256'],
    'finalWorktreeDiffSha256': worktree_hash,
    'node': node,
    'pnpm': pnpm,
    'baselinePathCount': len(baseline['files']),
    'baselineFilesChanged': changed,
    'unexpectedBaselineChanges': unexpected,
    'unexpectedNewPaths': unexpected_new,
    'newPathsAtAudit': new_paths,
    'scope': 'Tracked and non-ignored paths, including baseline missing files. Ignored build products excluded.',
}
(directory / 'final-integrity.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: value for key, value in result.items() if key != 'newPathsAtAudit'}, indent=2), flush=True)
if not result['indexUnchanged'] or head != baseline['head'] or unexpected or unexpected_new:
    sys.exit(1)
