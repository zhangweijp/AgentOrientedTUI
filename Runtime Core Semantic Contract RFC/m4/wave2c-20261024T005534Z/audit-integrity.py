import hashlib
import json
import os
import pathlib
import subprocess
import sys

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
baseline = json.loads((directory / 'baseline-readonly/inventory.json').read_text())
allowed = set(baseline['plannedTouch'])
new_source = {
    'runtime/src/core/tool/ref-declarations.ts',
    'runtime/src/core/tool/ref-declarations.wave2c.test.ts',
    'runtime/src/engine/app/worker-host.wave2c-declarations.test.ts',
    'sdk/src/ref-declarations.wave2c.test.ts',
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=root, env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})

changed, unexpected, missing_changed = [], [], []
for name, before in baseline['files'].items():
    p = root / name
    if before.get('missing'):
        if p.exists():
            missing_changed.append(name)
        continue
    if not p.is_file() or digest(p.read_bytes()) != before['sha256'] or p.is_symlink() != before['symlink']:
        changed.append(name)
        if name not in allowed:
            unexpected.append(name)

paths = set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')) - {''}
new_paths = sorted(paths - baseline['files'].keys())
prefix = str(directory.relative_to(root)) + '/'
unexpected_new = [p for p in new_paths if p not in new_source and not p.startswith(prefix)]
head = git('rev-parse', 'HEAD').decode().strip()
staged = digest(git('diff', '--cached', '--binary'))
audit_paths = [name for name in baseline['files'] if name.startswith('Runtime Core Semantic Contract RFC/') and
               any(part in name for part in ['independent-', '/stage8/', '/wave2a-', '/wave2b-'])]
host = 'runtime/src/engine/app/worker-host.ts'
host_before = (directory / 'baseline-readonly/sources' / host).read_text()
host_after = (root / host).read_text()
marker = '    private async sendLifecycleRequest('
types = 'runtime/src/core/snapshot/types.ts'
types_before = (directory / 'baseline-readonly/sources' / types).read_text()
types_after = (root / types).read_text()
sdk = 'sdk/src/hooks/useViewTypeTool.ts'
sdk_before = (directory / 'baseline-readonly/sources' / sdk).read_text()
sdk_after = (root / sdk).read_text()

def wrapper(text):
    return text[text.index('    const stableHandler = useMemo('):text.index('    // 注册 Type Tool 到 AppKernel')]

summary = {
    'head': head, 'headUnchanged': head == baseline['head'],
    'stagedFingerprintDefinition': 'SHA-256 of git diff --cached --binary output; NOT .git/index file bytes',
    'baselineStagedDiffSha256': baseline['stagedDiffSha256'], 'finalStagedDiffSha256': staged,
    'stagedDiffUnchanged': staged == baseline['stagedDiffSha256'],
    'baselineUnstagedDiffSha256': baseline['unstagedDiffSha256'],
    'finalUnstagedDiffSha256': digest(git('diff', '--binary')),
    'baselinePathRecords': len(baseline['files']),
    'baselineExistingFiles': sum(not value.get('missing', False) for value in baseline['files'].values()),
    'baselineMissingPaths': sum(value.get('missing', False) for value in baseline['files'].values()),
    'changedExistingFiles': changed, 'unexpectedExistingChanges': unexpected,
    'changedMissingStates': missing_changed, 'unexpectedNewPaths': unexpected_new,
    'unchangedBaselinePathRecords': len(baseline['files']) - len(changed) - len(missing_changed),
    'priorAuditAndDeliveryRecords': len(audit_paths),
    'changedPriorAuditAndDeliveryRecords': [name for name in changed if name in audit_paths],
    'hostBaselineSha256': baseline['files'][host]['sha256'], 'hostFinalSha256': digest((root / host).read_bytes()),
    'r1LifecycleAndHostTailUnchanged': host_before[host_before.index(marker):] == host_after[host_after.index(marker):],
    'snapshotEnvelopeTypeDefinitionsUnchanged': types_before.split('export type SnapshotIssueCode')[0] == types_after.split('export type SnapshotIssueCode')[0],
    'sdkBusinessAndValidationWrapperUnchanged': wrapper(sdk_before) == wrapper(sdk_after),
    'scope': baseline['scope'],
}
summary['ok'] = (summary['headUnchanged'] and summary['stagedDiffUnchanged'] and not unexpected and
                 not missing_changed and not unexpected_new and not summary['changedPriorAuditAndDeliveryRecords'] and
                 summary['r1LifecycleAndHostTailUnchanged'] and summary['snapshotEnvelopeTypeDefinitionsUnchanged'] and
                 summary['sdkBusinessAndValidationWrapperUnchanged'])
with (directory / sys.argv[1]).open('x') as output:
    output.write(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False))
sys.exit(0 if summary['ok'] else 1)
