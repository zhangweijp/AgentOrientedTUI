import datetime
import difflib
import hashlib
import json
import pathlib
import re

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
baseline = json.loads((directory / 'baseline.json').read_text())
integrity = json.loads((directory / 'final-integrity.json').read_text())
assert integrity['indexUnchanged'] and integrity['head'] == baseline['head']
assert integrity['hostOutsideReadOnlyUnchanged']
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
    ttl = re.search(r'^WAVE2A_TTL_RECHECK=(.*)$', text, re.MULTILINE)
    record['tests'] = counts(tests.group(1)) if tests else None
    record['testFilesOrSuites'] = counts(files.group(1)) if files else None
    record['r1Violations'] = {'violated': int(violations.group(1)), 'cases': int(violations.group(2))} if violations else None
    record['ttlSourceProbe'] = json.loads(ttl.group(1)) if ttl else None
    record['logSha256'] = sha(root / record['log'])
    runs.append(record)
by_name = {record['name']: record for record in runs}
final_names = ['final-wave2a-' + name for name in ['runtime-tsc', 'sdk-tsc', 'ide-tsc', 'runtime-vitest', 'sdk-vitest', 'ide-jest']]
round_names = ['stability-wave2a-' + str(number) for number in range(1, 4)]
assert all(by_name[name]['exitCode'] == 0 for name in final_names + round_names)
assert by_name['final-wave2a-runtime-vitest']['tests'] == {'passed': 631, 'failed': 0, 'skipped': 3, 'todo': 7}
assert by_name['final-wave2a-runtime-vitest']['testFilesOrSuites']['passed'] == 70
assert by_name['final-wave2a-sdk-vitest']['tests']['passed'] == 86
assert by_name['final-wave2a-ide-jest']['tests']['passed'] == 27
assert by_name['red-request-and-core']['tests'] == {'passed': 8, 'failed': 14, 'skipped': 0, 'todo': 0}
assert by_name['red-real-sdk-worker-confirmed']['tests'] == {'passed': 14, 'failed': 2, 'skipped': 0, 'todo': 0}
assert by_name['green-wave2a-first']['tests'] == {'passed': 38, 'failed': 0, 'skipped': 0, 'todo': 0}
assert by_name['red-real-sdk-worker-confirmed']['ttlSourceProbe'] == {'success': True, 'calls': {'A': 1, 'B': 0, 'query': 0}}
expected_ttl = {'success': False, 'code': 'SNAPSHOT_EXPIRED', 'calls': {'A': 0, 'B': 0, 'query': 0}}
for name in round_names:
    assert by_name[name]['tests'] == {'passed': 108, 'failed': 0, 'skipped': 0, 'todo': 0}
    assert by_name[name]['testFilesOrSuites']['passed'] == 9
    assert by_name[name]['ttlSourceProbe'] == expected_ttl
assert by_name['r1-independent-real-worker']['r1Violations'] == {'violated': 0, 'cases': 4}
assert by_name['r1-independent-controlled']['r1Violations'] == {'violated': 0, 'cases': 10}
assert by_name['r1-independent-real-worker']['exitCode'] == by_name['r1-independent-controlled']['exitCode'] == 0

source_names = ['runtime/src/engine/app/worker-host.ts',
                'runtime/src/engine/app/worker-host.wave2a-request.test.ts',
                'runtime/src/core/tool/source-binding.wave2a.test.ts',
                'runtime/src/engine/app/worker-host.wave2a-readonly.test.ts']
sources = []
patches = []
for name in source_names:
    old_path = pathlib.Path(baseline['backupDirectory']) / name
    before = old_path.read_text().splitlines(keepends=True) if old_path.is_file() else []
    after = (root / name).read_text().splitlines(keepends=True)
    patch = ''.join(difflib.unified_diff(before, after, fromfile='Wave2A-baseline/' + name if before else '/dev/null', tofile='Wave2A-current/' + name))
    patches.append(patch)
    sources.append({'path': name, 'origin': 'PREEXISTING_STAGED_AND_UNSTAGED' if before else 'NEW_THIS_WAVE2A',
                    'baselineSha256': baseline['files'].get(name, {}).get('sha256'), 'finalSha256': sha(root / name),
                    'addedLines': sum(line.startswith('+') and not line.startswith('+++') for line in patch.splitlines()),
                    'removedLines': sum(line.startswith('-') and not line.startswith('---') for line in patch.splitlines())})
(directory / 'incremental-changes.patch').write_text(''.join(patches))
security = [
    {'id': 'full-request-getters-json-selectors-and-proxy-boundary', 'status': 'VERIFIED_HOST_CORE',
     'red': 'red-request-and-core', 'note': 'Ordinary getters rejected without invocation. Proxy trap may execute; no JS sandbox claim.'},
    {'id': 'args-original-depth-node-byte-budgets', 'status': 'VERIFIED_HOST_CORE',
     'note': 'Depth 24, nodes 10000 and 128 KiB approximate UTF-8 boundaries unchanged; full request separately bounded.'},
    {'id': 'literal-true-controller-authorization', 'status': 'VERIFIED_HOST_CORE',
     'red': 'red-request-and-core', 'note': 'Truthy 1/string/object used to reach simulated dispatch; not claimed as public business-role exploitation.'},
    {'id': 'fixed-source-and-args-during-authorization', 'status': 'VERIFIED_REAL_SDK_WORKER',
     'red': 'red-real-sdk-worker-confirmed', 'note': 'Rechecking B while dispatching originally authorized A was observed; selector mismatch alone is not proof of foreign Handler execution.'},
    {'id': 'expired-pinned-source-cannot-be-laundered-with-new-selector', 'status': 'VERIFIED_REAL_SDK_WORKER',
     'red': 'red-real-sdk-worker-confirmed', 'note': 'Actual A Handler count 1 before fix; SNAPSHOT_EXPIRED with A/B/query counts 0 after fix. Source TTL bypass, not a claimed business-ACL bypass.'},
    {'id': 'source-policy-dispatch-exception-boundaries', 'status': 'VERIFIED_HOST_CORE',
     'red': 'red-request-and-core', 'note': 'Static failure data; Host does not inspect arbitrary thrown message getters.'},
    {'id': 'core-pin-history-ttl-current-snapshot-lease-renewal', 'status': 'EXISTING_IMPLEMENTATION_VERIFIED_CORE_ONLY',
     'note': 'Pinned data availability differs from fresh acquire authority. No Core TTL rules changed.'},
    {'id': 'two-filedetails-same-tool-real-handler-and-remount-isolation', 'status': 'EXISTING_IMPLEMENTATION_VERIFIED_REAL_SDK_WORKER',
     'note': 'Old A rejects after close/remount, cannot hit fresh A/B, old still-valid B remains callable.'},
    {'id': 'tool-only-disabled-reregister-schema-and-live-registry', 'status': 'EXISTING_IMPLEMENTATION_VERIFIED_REAL_SDK_WORKER',
     'note': 'Authorization gates and dropped PREPARED fault injection exercise Core and Worker checks independently; user Handler counts zero on rejection.'},
    {'id': 'display-ref-only-and-no-latest-ref-fallback', 'status': 'VERIFIED_REAL_SDK_WORKER',
     'note': 'Old valid Tool remains callable. Reference-shaped JSON remains literal; generic source-bound Ref argument decoding is unsupported.'},
    {'id': 'sdk-args-and-operationresult-business-failure', 'status': 'EXISTING_IMPLEMENTATION_VERIFIED_REAL_SDK_WORKER',
     'note': 'E_INVALID_ARGS before user Handler; IPC delivery success=true can contain business success=false.'},
    {'id': 'app-close-error-reset-appinstance-and-r1', 'status': 'VERIFIED_REAL_SDK_WORKER_AND_R1_SCRIPTS',
     'note': 'Late grants do not dispatch; reset uses fresh AppInstance and rejects old Snapshot. All R1 cases retained.'},
]
gate = {
    'stage': 'Wave 2A limited read-only source execution contract',
    'generatedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'head': integrity['head'],
    'baselineIndexSha256': baseline['baselineIndexSha256'], 'finalIndexSha256': integrity['finalIndexSha256'],
    'indexUnchanged': integrity['indexUnchanged'], 'baselineHostSha256': baseline['baselineHostSha256'],
    'finalHostSha256': integrity['finalHostSha256'],
    'baselineWorktreeDiffSha256': baseline['baselineWorktreeDiffSha256'], 'finalWorktreeDiffSha256': integrity['finalWorktreeDiffSha256'],
    'environment': {'node': integrity['node'], 'pnpm': integrity['pnpm']},
    'tests': runs, 'finalRegression': [by_name[name] for name in final_names],
    'stabilityRounds': [by_name[name] for name in round_names],
    'newTests': {'total': 38, 'hostCore': 20, 'pureCore': 2, 'realSdkWorker': 16},
    'redGreen': {'hostCoreRed': by_name['red-request-and-core'], 'realRedConfirmed': by_name['red-real-sdk-worker-confirmed'],
                 'green': by_name['green-wave2a-first'], 'initialFixtureRun': by_name['red-real-sdk-worker'],
                 'fixtureCorrection': 'Strengthened wait to require actual remounted View and matching Tool target; no timeout or security expectation relaxed.'},
    'securityCases': security, 'sourceChanges': sources,
    'integrity': {'report': relative(directory / 'final-integrity.json'), 'log': by_name['integrity-wave2a']['log'],
                  'baselinePaths': integrity['baselinePathCount'], 'changedPreexistingPaths': integrity['changedPreexistingPaths'],
                  'hostOutsideReadOnlyUnchanged': True, 'unexpectedBaselineChanges': [], 'unexpectedNewPaths': [],
                  'protectedStage8EvidenceFiles': len(integrity['protectedStage8Evidence'])},
    'compatibility': {'existingTestsModified': False, 'coreSdkIdeWorkerProductionChanged': False,
                      'snapshotSchemaChanged': False, 'ipcSchemaChanged': False, 'legacyFiveParameterApiChanged': False,
                      'defaultRouterChanged': False, 'experimentalReadOnlyDefault': 'OFF', 'experimentalMutatingDefaultsChanged': False,
                      'producerConsistency': 'unverified', 'strictEligible': False, 'agentsStarted': False},
    'performance': {'status': 'NOT_TESTED', 'cpu': None, 'heap': None, 'productP50Ms': None, 'productP95Ms': None,
                    'note': 'No dedicated performance Gate. Existing readonly test diagnostics and command duration are not product SLA.'},
    'coverage': {'status': 'NOT_TESTED', 'linesPercent': None, 'branchesPercent': None},
    'unsupported': ['Generic source-bound Ref argument codec/authorization; reference strings/objects are caller JSON only.',
                    'Frozen business/closure state inside one SDK stable Handler binding.',
                    'Atomic Host/Worker deadline, post-dispatch TTL cancellation, rollback or exactly-once.',
                    'Hostile JavaScript/Proxy/Handler OS sandbox guarantees.'],
    'goNoGo': {'recommendation': 'Wave 2A 限定交付完成，等待 ChatGPT 验收', 'independentAcceptance': 'PENDING',
                'fullM4': 'NOT_DECLARED', 'strict': 'NO_GO', 'defaultAgentRouterSwitch': 'NOT_AUTHORIZED',
                'mutatingEnablement': 'NOT_AUTHORIZED', 'subsequentWaves': 'NOT_STARTED'},
    'blockers': [],
}
(directory / 'GATE_STATUS.json').write_text(json.dumps(gate, ensure_ascii=False, indent=2) + '\n')
artifacts = sorted(path for path in directory.rglob('*') if path.is_file() and path.name != 'source-fingerprints.json')
manifest = {'stage': gate['stage'], 'head': gate['head'], 'baselineIndexSha256': gate['baselineIndexSha256'],
            'finalIndexSha256': gate['finalIndexSha256'], 'sources': sources,
            'baselinePreservation': {'inventory': relative(directory / 'baseline.json'), 'pathsChecked': integrity['baselinePathCount'],
                                     'changedPreexistingPaths': integrity['changedPreexistingPaths'], 'unexpectedChanges': [],
                                     'protectedStage8Evidence': integrity['protectedStage8Evidence'], 'scope': integrity['scope']},
            'artifacts': [{'path': relative(path), 'sha256': sha(path)} for path in artifacts],
            'selfHashPolicy': 'Manifest excludes its own recursive digest.'}
(directory / 'source-fingerprints.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'recommendation': gate['goNoGo']['recommendation'], 'sourceFiles': len(sources),
                  'productionAddedLines': sources[0]['addedLines'], 'productionRemovedLines': sources[0]['removedLines'],
                  'rawCommandLogs': len(runs), 'artifactFiles': len(artifacts),
                  'protectedStage8Files': len(integrity['protectedStage8Evidence']),
                  'indexUnchanged': gate['indexUnchanged']}, ensure_ascii=False, indent=2))
