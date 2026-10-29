import datetime
import difflib
import hashlib
import json
import pathlib
import re

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[3]
baseline = json.loads((directory / 'baseline.json').read_text())
integrity = json.loads((directory / 'final-integrity.json').read_text())
assert integrity['indexUnchanged'] and integrity['head'] == baseline['head']
assert not integrity['unexpectedBaselineChanges'] and not integrity['unexpectedNewPaths']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path):
    return str(path.relative_to(root))


def counts(line):
    return {key: int(match.group(1)) if (match := re.search(r'(\d+) ' + key + r'\b', line)) else 0
            for key in ['passed', 'failed', 'skipped', 'todo']}


runs = []
for line in (directory / 'commands.jsonl').read_text().splitlines():
    record = json.loads(line)
    text = (root / record['log']).read_text()
    assert text.rstrip().endswith('EXIT_CODE: ' + str(record['exitCode']))
    tests = re.search(r'^\s*Tests(?:\s+|:\s*)(.*)$', text, re.MULTILINE)
    files = re.search(r'^\s*(?:Test Files\s+|Test Suites:\s*)(.*)$', text, re.MULTILINE)
    violations = re.search(r'(?:REAL_WORKER_)?VIOLATIONS=(\d+)/(\d+)', text)
    record['tests'] = counts(tests.group(1)) if tests else None
    record['testFilesOrSuites'] = counts(files.group(1)) if files else None
    record['independentViolations'] = {'violated': int(violations.group(1)), 'cases': int(violations.group(2))} if violations else None
    record['logSha256'] = sha(root / record['log'])
    runs.append(record)
by_name = {record['name']: record for record in runs}
final_names = ['final-r1-' + name for name in ['runtime-tsc', 'sdk-tsc', 'ide-tsc', 'runtime-vitest', 'sdk-vitest', 'ide-jest']]
round_names = ['stability-r1-' + str(number) for number in range(1, 4)]
assert all(by_name[name]['exitCode'] == 0 for name in final_names + round_names)
assert by_name['final-r1-runtime-vitest']['tests'] == {'passed': 593, 'failed': 0, 'skipped': 3, 'todo': 7}
assert by_name['final-r1-sdk-vitest']['tests']['passed'] == 86
assert by_name['final-r1-ide-jest']['tests']['passed'] == 27
assert by_name['red-r1-regression']['tests'] == {'passed': 2, 'failed': 27, 'skipped': 0, 'todo': 0}
for name in round_names:
    assert by_name[name]['tests'] == {'passed': 58, 'failed': 0, 'skipped': 0, 'todo': 0}
    assert by_name[name]['testFilesOrSuites']['passed'] == 6
for suffix, cases in [('real-worker', 4), ('controlled', 10)]:
    assert by_name['red-independent-' + suffix]['independentViolations'] == {'violated': cases, 'cases': cases}
    assert by_name['green-independent-' + suffix]['independentViolations'] == {'violated': 0, 'cases': cases}
    assert by_name['red-independent-' + suffix]['exitCode'] == 1
    assert by_name['green-independent-' + suffix]['exitCode'] == 0

source_names = ['runtime/src/engine/app/worker-host.ts', 'runtime/src/engine/app/worker-host.r1-terminal-race.test.ts']
sources = []
patches = []
for name in source_names:
    old_path = pathlib.Path(baseline['backupDirectory']) / name
    before = old_path.read_text().splitlines(keepends=True) if old_path.is_file() else []
    after = (root / name).read_text().splitlines(keepends=True)
    patch = ''.join(difflib.unified_diff(before, after, fromfile='R1-baseline/' + name if before else '/dev/null', tofile='R1-current/' + name))
    patches.append(patch)
    sources.append({'path': name, 'origin': 'PREEXISTING_STAGED_AND_UNSTAGED' if before else 'NEW_THIS_R1',
                    'baselineSha256': baseline['files'].get(name, {}).get('sha256'), 'finalSha256': sha(root / name),
                    'addedLines': sum(line.startswith('+') and not line.startswith('+++') for line in patch.splitlines()),
                    'removedLines': sum(line.startswith('-') and not line.startswith('---') for line in patch.splitlines())})
assert sources[0]['addedLines'] == 8 and sources[0]['removedLines'] == 0
(directory / 'incremental-changes.patch').write_text(''.join(patches))
gate = {
    'stage': 'M4 Stage 8 R1 only', 'generatedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head': integrity['head'], 'baselineIndexSha256': baseline['baselineIndexSha256'],
    'finalIndexSha256': integrity['finalIndexSha256'], 'indexUnchanged': integrity['indexUnchanged'],
    'baselineWorktreeDiffSha256': baseline['baselineWorktreeDiffSha256'],
    'finalWorktreeDiffSha256': integrity['finalWorktreeDiffSha256'],
    'environment': {'node': integrity['node'], 'pnpm': integrity['pnpm']},
    'tests': runs, 'finalRegression': [by_name[name] for name in final_names],
    'stabilityRounds': [by_name[name] for name in round_names],
    'redGreen': {
        'independentRealWorker': {'red': by_name['red-independent-real-worker'], 'green': by_name['green-independent-real-worker']},
        'independentControlledTransport': {'red': by_name['red-independent-controlled'], 'green': by_name['green-independent-controlled']},
        'formalRegression': {'red': by_name['red-r1-regression'], 'greenWithExistingLifecycle': by_name['green-r1-regression'], 'newCases': 29},
    },
    'invariants': [
        {'id': 'fulfilled-then-terminate-exit-error', 'status': 'VERIFIED', 'methods': ['start', 'open', 'pause', 'resume', 'reinitialize'], 'cases': 15},
        {'id': 'same-owner-same-error-status-invalidates-return', 'status': 'VERIFIED', 'cases': 1},
        {'id': 'same-worker-new-init-invalidates-previous-context', 'status': 'VERIFIED', 'cases': 5},
        {'id': 'legitimate-new-recovery-and-close-reopen', 'status': 'VERIFIED', 'cases': 2},
        {'id': 'real-worker-external-listener-terminates-after-host-fulfilment', 'status': 'VERIFIED', 'cases': 5},
        {'id': 'real-public-start-creates-different-worker-without-old-state-pollution', 'status': 'VERIFIED', 'cases': 1},
        {'id': 'existing-close-release-io-listener-pending-reset-behavior', 'status': 'REGRESSION_PASSED', 'evidence': final_names + round_names},
    ],
    'sourceChanges': sources,
    'integrity': {'report': relative(directory / 'final-integrity.json'), 'log': by_name['integrity-r1']['log'],
                  'baselinePaths': integrity['baselinePathCount'], 'changedPreexistingPaths': integrity['changedPreexistingPaths'],
                  'unexpectedBaselineChanges': [], 'unexpectedNewPaths': [],
                  'independentReviewFilesPreserved': len(integrity['independentReviewFiles'])},
    'compatibility': {'existingTestsModified': False, 'coreSdkIdeProductionChanged': False,
                      'defaultRouterChanged': False, 'experimentalDefaultsChanged': False,
                      'strictFlagsChanged': False, 'independentScriptsModified': False, 'agentsStarted': False},
    'performance': {'status': 'NOT_TESTED', 'productLatencyMs': None, 'note': 'Command durations are test evidence only.'},
    'coverage': {'status': 'NOT_TESTED', 'linesPercent': None, 'branchesPercent': None},
    'goNoGo': {'r1Recommendation': 'Stage 8 R1 修复完成，等待 ChatGPT 再验收',
                'stage8': 'REQUEST_CHANGES_PENDING_INDEPENDENT_RE_REVIEW', 'stage8PassDeclared': False,
                'wave2': 'NOT_STARTED', 'reviewer': 'ChatGPT', 'independentAcceptance': 'PENDING'},
    'blockers': [],
    'remainingLimits': ['Invalidated lifecycle does not prove Worker callbacks or side effects never executed; no rollback/cancel/retry was added.',
                        'Existing Strict, file CAS/ABA, durable exactly-once and performance limitations remain outside R1.'],
}
(directory / 'R1_GATE_STATUS.json').write_text(json.dumps(gate, ensure_ascii=False, indent=2) + '\n')
artifacts = sorted(path for path in directory.rglob('*') if path.is_file() and path.name != 'source-fingerprints.json')
manifest = {'stage': gate['stage'], 'head': gate['head'], 'baselineIndexSha256': gate['baselineIndexSha256'],
            'finalIndexSha256': gate['finalIndexSha256'], 'sources': sources,
            'baselinePreservation': {'inventory': relative(directory / 'baseline.json'), 'pathsChecked': integrity['baselinePathCount'],
                                     'changedPreexistingPaths': integrity['changedPreexistingPaths'], 'unexpectedChanges': [],
                                     'independentReviewFiles': integrity['independentReviewFiles'], 'scope': integrity['scope']},
            'artifacts': [{'path': relative(path), 'sha256': sha(path)} for path in artifacts],
            'selfHashPolicy': 'Manifest excludes its own recursive digest.'}
(directory / 'source-fingerprints.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'recommendation': gate['goNoGo']['r1Recommendation'], 'sourceFiles': len(sources),
                  'productionAddedLines': sources[0]['addedLines'], 'rawCommandLogs': len(runs),
                  'artifactFiles': len(artifacts), 'indexUnchanged': gate['indexUnchanged']}, ensure_ascii=False, indent=2))
