"""Read-only protection audit; writes only the requested new evidence JSON."""
import hashlib
import json
import pathlib
import subprocess
import sys

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
baseline = json.loads((directory / 'baseline-readonly/inventory.json').read_text())

def digest(data):
    return hashlib.sha256(data).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=root)

changed = []
for name, before in baseline['files'].items():
    path = root / name
    if before.get('missing'):
        if path.exists():
            changed.append(name)
    elif not path.is_file() or digest(path.read_bytes()) != before['sha256'] or path.is_symlink() != before['symlink']:
        changed.append(name)

new_tests = {
    'runtime/src/core/snapshot/ref-contract.wave2b.test.ts',
    'sdk/src/ref-contract.wave2b.test.ts',
}
prefix = str(directory.relative_to(root)) + '/'
current_paths = set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')) - {''}
new_paths = sorted(current_paths - baseline['files'].keys())
unexpected = [name for name in new_paths if name not in new_tests and not name.startswith(prefix)]
head = git('rev-parse', 'HEAD').decode().strip()
index = digest(git('diff', '--cached', '--binary'))
worktree = digest(git('diff', '--binary'))
host = 'runtime/src/engine/app/worker-host.ts'
host_sha = digest((root / host).read_bytes())
audit_paths = [name for name in baseline['files'] if
               name.startswith('Runtime Core Semantic Contract RFC/') and
               ('independent-' in name or '/stage8/' in name or '/wave2a-' in name)]
summary = {
    'head': head,
    'headUnchanged': head == baseline['head'],
    'baselineIndexSha256': baseline['indexSha256'],
    'finalIndexSha256': index,
    'indexUnchanged': index == baseline['indexSha256'],
    'baselineTrackedWorktreeSha256': baseline['worktreeSha256'],
    'finalTrackedWorktreeSha256': worktree,
    'trackedDiffUnchanged': worktree == baseline['worktreeSha256'],
    'workerHostSha256': host_sha,
    'workerHostUnchanged': host_sha == baseline['files'][host]['sha256'],
    'protectedExistingFiles': len(baseline['files']),
    'changedExistingFiles': changed,
    'protectedPriorAuditAndDeliveryFiles': len(audit_paths),
    'changedPriorAuditAndDeliveryFiles': [name for name in changed if name in audit_paths],
    'unexpectedNewPaths': unexpected,
    'newPaths': new_paths,
    'scope': 'tracked and nonignored untracked at batch start; ignored compiler output/cache is outside the inventory',
}
summary['ok'] = (summary['headUnchanged'] and summary['indexUnchanged'] and summary['trackedDiffUnchanged']
                 and summary['workerHostUnchanged'] and not changed and not unexpected)
target = directory / sys.argv[1]
with target.open('x') as output:
    output.write(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: value for key, value in summary.items() if key != 'newPaths'}, ensure_ascii=False))
sys.exit(0 if summary['ok'] else 1)
