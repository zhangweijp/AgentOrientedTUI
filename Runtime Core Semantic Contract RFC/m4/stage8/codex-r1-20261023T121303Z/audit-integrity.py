import hashlib
import json
import pathlib
import shlex
import subprocess
import sys

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[3]
baseline = json.loads((directory / 'baseline.json').read_text())


def command(args):
    print('COMMAND: ' + shlex.join(args), flush=True)
    result = subprocess.run(args, cwd=root, capture_output=True)
    print(result.stdout.decode(), end='', flush=True)
    print(result.stderr.decode(), end='', flush=True)
    print('EXIT_CODE: ' + str(result.returncode), flush=True)
    if result.returncode:
        sys.exit(result.returncode)
    return result.stdout


head = command(['git', 'rev-parse', 'HEAD']).decode().strip()
status = command(['git', 'status', '--porcelain=v1']).decode()
(directory / 'final-status.log').write_text(status)
hashes = {}
for key, args in [('index', ['git', 'diff', '--cached', '--binary']), ('worktree', ['git', 'diff', '--binary'])]:
    diff = subprocess.check_output(args, cwd=root)
    print('COMMAND: ' + shlex.join(args) + ' | shasum -a 256', flush=True)
    digest = subprocess.run(['shasum', '-a', '256'], input=diff, capture_output=True, check=True).stdout.decode().split()[0]
    hashes[key] = digest
    print(digest, flush=True)
node = command(['node', '--version']).decode().strip()
pnpm = command(['pnpm', '--version']).decode().strip()
command(['pnpm', '--dir', 'runtime', 'exec', 'vitest', '--version'])
changed = []
review = []
for name, record in baseline['files'].items():
    path = root / name
    current = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    item = {'path': name, 'baselineSha256': record['sha256'], 'finalSha256': current}
    if current != record['sha256']:
        changed.append(item)
    if name.startswith('Runtime Core Semantic Contract RFC/m4/stage8/independent-review-20261023-01/'):
        review.append(item)
unexpected = [item for item in changed if item['path'] != 'runtime/src/engine/app/worker-host.ts']
current_paths = set(subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')) - {''}
new_paths = sorted(current_paths - set(baseline['files']))
prefix = str(directory.relative_to(root)) + '/'
unexpected_new = [name for name in new_paths if not name.startswith(prefix) and name != 'runtime/src/engine/app/worker-host.r1-terminal-race.test.ts']
result = {
    'head': head, 'baselineIndexSha256': baseline['baselineIndexSha256'], 'finalIndexSha256': hashes['index'],
    'indexUnchanged': hashes['index'] == baseline['baselineIndexSha256'],
    'baselineWorktreeDiffSha256': baseline['baselineWorktreeDiffSha256'], 'finalWorktreeDiffSha256': hashes['worktree'],
    'node': node, 'pnpm': pnpm, 'baselinePathCount': len(baseline['files']),
    'changedPreexistingPaths': changed, 'unexpectedBaselineChanges': unexpected,
    'newPathsAtAudit': new_paths, 'unexpectedNewPaths': unexpected_new,
    'independentReviewFiles': review, 'scope': baseline['baselineScope'],
}
(directory / 'final-integrity.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: value for key, value in result.items() if key not in ['newPathsAtAudit', 'independentReviewFiles']}, indent=2), flush=True)
print('Independent review files verified: ' + str(len(review)), flush=True)
if head != baseline['head'] or not result['indexUnchanged'] or unexpected or unexpected_new:
    sys.exit(1)
