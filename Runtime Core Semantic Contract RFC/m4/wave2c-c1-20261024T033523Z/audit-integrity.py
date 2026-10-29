import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
baseline = json.loads((directory / 'baseline.json').read_text())
environment = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=root, env=environment)


def fingerprint(path):
    if path.is_symlink():
        return {'symlink': os.readlink(path)}
    if path.is_file():
        data = path.read_bytes()
        return {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
    return {'missing': True}


changed = [name for name, before in baseline['files'].items() if fingerprint(root / name) != before]
current = set(name.decode() for name in git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0') if name)
current.update(str(path.relative_to(root)) for path in (root / 'Runtime Core Semantic Contract RFC').rglob('*')
               if path.is_file() or path.is_symlink())
added = sorted(current - baseline['files'].keys())
own_prefix = str(directory.relative_to(root)) + '/'
unexpected_added = [name for name in added if name != baseline['newTest'] and not name.startswith(own_prefix)]
unexpected_changed = [name for name in changed if name not in baseline['plannedTouch']]
rfc_names = [name for name in baseline['files'] if name.startswith('Runtime Core Semantic Contract RFC/')]
missing_names = [name for name, state in baseline['files'].items() if state.get('missing')]
old_tests = ['runtime/src/core/tool/ref-declarations.wave2c.test.ts',
             'runtime/src/engine/app/worker-host.wave2c-declarations.test.ts',
             'sdk/src/ref-declarations.wave2c.test.ts',
             'runtime/src/engine/app/worker-host.r1-terminal-race.test.ts']
index_path = pathlib.Path(git('rev-parse', '--git-path', 'index').decode().strip())
if not index_path.is_absolute():
    index_path = root / index_path
result = {
    'capturedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head': git('rev-parse', 'HEAD').decode().strip(),
    'baselineIndexSha256': baseline['stagedDiffSha256'],
    'finalIndexSha256': hashlib.sha256(git('diff', '--cached', '--binary')).hexdigest(),
    'indexHashMeaning': 'SHA-256 of git diff --cached --binary output; separate raw index file hash below',
    'baselineIndexFileSha256': baseline['indexFileSha256'],
    'finalIndexFileSha256': hashlib.sha256(index_path.read_bytes()).hexdigest(),
    'baselineUnstagedDiffSha256': baseline['unstagedDiffSha256'],
    'finalUnstagedDiffSha256': hashlib.sha256(git('diff', '--binary')).hexdigest(),
    'baselinePathRecords': len(baseline['files']),
    'baselineExistingFiles': sum('sha256' in state for state in baseline['files'].values()),
    'unchangedPathRecords': len(baseline['files']) - len(changed),
    'changedExistingPaths': changed,
    'unexpectedChangedPaths': unexpected_changed,
    'unexpectedNewPaths': unexpected_added,
    'baselineMissingPaths': len(missing_names),
    'missingStatesUnchanged': all(fingerprint(root / name).get('missing') for name in missing_names),
    'protectedRFCPathRecords': len(rfc_names),
    'allPreviousRFCRecordsUnchanged': all(name not in changed for name in rfc_names),
    'originalTestFilesUnchanged': {name: name not in changed for name in old_tests},
    'newSourcePaths': [name for name in added if not name.startswith(own_prefix)],
    'scope': 'Tracked/nonignored untracked paths plus all pre-existing RFC files; ignored build outputs/caches excluded',
    'note': 'The changed Core module was already untracked at batch start, so unstaged diff output alone cannot prove its preservation.',
}
result['indexFileUnchanged'] = result['baselineIndexFileSha256'] == result['finalIndexFileSha256']
result['pass'] = (result['head'] == baseline['head'] and
                  result['baselineIndexSha256'] == result['finalIndexSha256'] and
                  result['indexFileUnchanged'] and not unexpected_changed and not unexpected_added and
                  set(changed) == set(baseline['plannedTouch']) and result['missingStatesUnchanged'] and
                  result['allPreviousRFCRecordsUnchanged'] and all(result['originalTestFilesUnchanged'].values()) and
                  result['newSourcePaths'] == [baseline['newTest']])
(directory / 'integrity-final.json').write_text(json.dumps(result, indent=2) + '\n')
(directory / 'final-status.porcelain-v1.txt').write_bytes(git('status', '--porcelain=v1', '--untracked-files=all'))
print(json.dumps(result, indent=2))
sys.exit(0 if result['pass'] else 1)
