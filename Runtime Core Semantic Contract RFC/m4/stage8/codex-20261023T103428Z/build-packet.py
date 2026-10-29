import datetime
import hashlib
import json
import pathlib
import re

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[3]
stage = directory.parent
baseline = json.loads((directory / 'baseline.json').read_text())
integrity = json.loads((directory / 'final-integrity.json').read_text())
assert integrity['indexUnchanged']
assert not integrity['unexpectedBaselineChanges']
assert not integrity['unexpectedNewPaths']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path):
    return str(path.relative_to(root))


def counts(line):
    return {key: int(match.group(1)) if (match := re.search(r'(\d+) ' + key + r'\b', line)) else 0
            for key in ['passed', 'failed', 'skipped', 'todo']}


records = []
for line in (directory / 'commands.jsonl').read_text().splitlines():
    record = json.loads(line)
    text = (root / record['log']).read_text()
    assert text.rstrip().endswith('EXIT_CODE: ' + str(record['exitCode']))
    tests = re.search(r'^\s*Tests(?:\s+|:\s*)(.*)$', text, re.MULTILINE)
    files = re.search(r'^\s*(?:Test Files\s+|Test Suites:\s*)(.*)$', text, re.MULTILINE)
    record['tests'] = counts(tests.group(1)) if tests else None
    record['testFilesOrSuites'] = counts(files.group(1)) if files else None
    record['logSha256'] = sha(root / record['log'])
    records.append(record)

final_names = ['final-delivery-' + name for name in [
    'runtime-tsc', 'sdk-tsc', 'ide-tsc', 'runtime-vitest', 'sdk-vitest', 'ide-jest',
]] + ['stability-delivery-' + str(number) for number in range(1, 4)]
by_name = {record['name']: record for record in records}
final = [by_name[name] for name in final_names]
assert all(record['exitCode'] == 0 for record in final)
assert by_name['final-delivery-runtime-vitest']['tests'] == {'passed': 564, 'failed': 0, 'skipped': 3, 'todo': 7}
assert by_name['final-delivery-sdk-vitest']['tests']['passed'] == 86
assert by_name['final-delivery-ide-jest']['tests']['passed'] == 27
for number in range(1, 4):
    record = by_name['stability-delivery-' + str(number)]
    assert record['tests'] == {'passed': 46, 'failed': 0, 'skipped': 0, 'todo': 0}
    assert record['testFilesOrSuites']['passed'] == 9

source = 'runtime/src/engine/app/'
case_data = [
    ('frozen-request-getter-proxy-byte-budget', 'PASS', 'REAL_SDK_WORKER_V2', [source + 'worker-host.m4-versioned-file.test.ts'],
     'Getter-free request; Proxy trap may execute before rejection; 4 MiB UTF-8; all selectors/content changed while policy awaits.'),
    ('explicit-authorization-and-exception-boundaries', 'PASS', 'HOST_CORE_REAL_TEMP_FILESYSTEM', [source + 'worker-host.m4-stage8-outcome.test.ts'],
     'Only literal true grants; source selection and thrown message accessors become deterministic failures without adapter IO.'),
    ('close-reset-single-flight-and-late-lifecycle-responses', 'PASS', 'HOST_UNIT_AND_REAL_WORKER', [source + 'worker-host.m4-lifecycle.test.ts', source + 'worker-host.m4-versioned-file.test.ts'],
     'Waits existing INIT/open/pause/resume/reinitialize, file IO, close and RESET; does not revive closing Host or duplicate shutdown/reset.'),
    ('close-during-authorization', 'PASS', 'REAL_SDK_WORKER_V2_REAL_TEMP_FILESYSTEM', [source + 'worker-host.m4-versioned-file.test.ts'],
     'Late grant after close returns APP_STOPPED, adapter is not invoked.'),
    ('close-during-successful-write-and-worker-reuse', 'PASS', 'REAL_SDK_WORKER_V2_REAL_TEMP_FILESYSTEM', [source + 'worker-host.m4-versioned-file.test.ts'],
     'Gated successful disk write still returns success; one APP_SHUTDOWN/APP_CLOSE/RESET; new AppInstance rejects old snapshot.'),
    ('terminate-and-worker-exit-cleanup', 'PASS', 'HOST_UNIT_AND_EXISTING_REAL_WORKER_CHANNEL', [source + 'worker-host.m4-lifecycle.test.ts', source + 'worker-host.snapshot-shadow.test.ts'],
     'Deferred termination; broken postMessage; pending request rejection; external exit observers preserved.'),
    ('same-hash-inflight-replay-fence', 'PASS', 'HOST_CORE_REAL_TEMP_FILESYSTEM', [source + 'worker-host.m4-stage8-outcome.test.ts', source + 'worker-host.m4-lifecycle.test.ts'],
     'Reserves before adapter await; identical bytes cannot prove operation did not execute; UI-only snapshot changes cannot remove fence.'),
    ('written-conflict-unknown-outcomes', 'PASS', 'HOST_CORE_REAL_TEMP_FILESYSTEM_AND_REAL_WORKER', [source + 'worker-host.m4-stage8-outcome.test.ts', source + 'worker-host.m4-versioned-file.test.ts'],
     'Actual committed write with invalid result/accessor remains unknown; no blind retry. Valid conflict releases only pending reservation.'),
    ('v2-producer-epoch-fault-injection', 'PASS_EXISTING_IMPLEMENTATION_REVERIFIED', 'REAL_SDK_WORKER_V2', [source + 'worker-host.m4-producer-race.test.ts'],
     'Epoch advances during Draft capture, Prepare Failed without torn publication, later stable capture recovers. Remains unverified/non-Strict.'),
    ('two-filedetails-shared-ref-and-tool-names', 'PASS_EXISTING_IMPLEMENTATION_EXTENDED_TEST', 'CORE_REAL_TEMP_FILESYSTEM', ['runtime/src/core/tool/versioned-file-integration.test.ts'],
     'Distinct ViewInstances and files share file/replace_file names; real writes verify B preserves A and A preserves B; A policy rejects B. Not a full dual-view Host E2E claim.'),
    ('business-result-legacy-and-optin-compatibility', 'PASS', 'FULL_REGRESSION_AND_REAL_WORKER', [source + 'worker-host.p0-tool-result.test.ts', source + 'worker-host.m4-readonly.test.ts', source + 'worker-host.m4-view-owned-e2e.test.ts'],
     'Preserves business ToolResult; no default Agent router switch; read-only mutating rejection and live tool/schema checks retained.'),
]
security = []
for case_id, status, level, paths, explanation in case_data:
    security.append({'id': case_id, 'status': status, 'evidenceLevel': level, 'testFiles': paths,
                     'finalLogs': [by_name['stability-delivery-' + str(number)]['log'] for number in range(1, 4)],
                     'notes': explanation})

gate = {
    'stage': 'M4 Stage 8 / Wave 1',
    'generatedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head': integrity['head'],
    'baselineIndexSha256': baseline['baselineIndexSha256'],
    'finalIndexSha256': integrity['finalIndexSha256'],
    'indexUnchanged': integrity['indexUnchanged'],
    'baselineWorktreeDiffSha256': baseline['baselineWorktreeDiffSha256'],
    'finalWorktreeDiffSha256': integrity['finalWorktreeDiffSha256'],
    'environment': {'node': integrity['node'], 'pnpm': integrity['pnpm'], 'platform': 'User Mac; Node worker_threads; isolated mkdtemp file workspaces'},
    'baselineTests': [record for record in records if record['name'].startswith('baseline-')],
    'tests': final,
    'allRuns': records,
    'securityCases': security,
    'performance': {
        'status': 'NOT_TESTED', 'cpu': None, 'heap': None, 'snapshotCommitP50Ms': None,
        'snapshotCommitP95Ms': None, 'invocationP50Ms': None, 'invocationP95Ms': None,
        'rejectionRate': None, 'workloadBudget': None,
        'note': 'Command durations are raw test execution evidence only, not product latency or SLA. Real IDE/LSP and scale profiling deferred to Wave 4.',
    },
    'coverage': {'status': 'NOT_TESTED', 'linesPercent': None, 'branchesPercent': None,
                 'addedRuntimeTestCases': 26, 'baselineRuntimePassed': 538, 'finalRuntimePassed': 564,
                 'note': 'No coverage command run. Baseline 3 skipped / 7 todo preserved; no new skip/todo.'},
    'goNoGo': {
        'stage8Limited': 'PASS_RECOMMENDED_PENDING_INDEPENDENT_REVIEW',
        'fullM4': 'NO_GO', 'strict': 'NO_GO', 'defaultAgentMutatingEnablement': 'NO_GO',
        'wave2Execution': 'NOT_STARTED', 'independentReviewer': 'ChatGPT', 'reviewStatus': 'PENDING',
    },
    'compatibility': {'experimentalVersionedMutationsDefault': 'OFF', 'legacyRouter': 'UNCHANGED',
                      'note': 'No claim that every preexisting Legacy mutating operation was disabled.'},
    'blockers': [],
    'assuranceBlockers': [
        'No comprehensive Strict CommitBarrier proof; producer remains unverified and strictEligible=false.',
        'Uncooperative external filesystem writers, content-hash ABA, and metadata/ACL/xattr/inode preservation are not solved.',
        'Host replay fence is not durable exactly-once across RESET/new AppInstance or process restart.',
        'Proxy traps may execute during JSON reflection; no hostile-JavaScript isolation or synchronous timeout guarantee.',
        'View/Tool teardown can race filesystem commit after live Worker validation; no distributed atomicity claim.',
        'No cancellation/time bound for an adapter or trusted policy that never settles.',
        'No real IDE/LSP workload profile, second independent non-DOM adapter, p50/p95 or scale budgets tested.',
    ],
    'integrity': {'log': by_name['integrity-delivery']['log'], 'report': relative(directory / 'final-integrity.json'),
                  'baselinePaths': integrity['baselinePathCount'], 'preexistingPathsChanged': len(integrity['baselineFilesChanged']),
                  'unexpectedBaselineChanges': [], 'unexpectedNewPaths': []},
    'artifacts': {'results': relative(stage / 'CODEX_RESULTS.md'),
                  'fingerprints': relative(stage / 'source-fingerprints.json'),
                  'nextWave': relative(stage / 'NEXT_WAVE_RECOMMENDATION.md'),
                  'incrementalPatch': relative(directory / 'incremental-changes.patch'),
                  'rawLogsDirectory': relative(directory), 'reproducer': relative(directory / 'run-check.py')},
}
(stage / 'GATE_STATUS.json').write_text(json.dumps(gate, ensure_ascii=False, indent=2) + '\n')

details = [
    ('worker-host.ts', 'PREEXISTING_STAGED_AND_UNSTAGED', 'Host lifecycle coordination, file replay reservation and outcome validation'),
    ('worker-host.m4-lifecycle.test.ts', 'PREEXISTING_UNTRACKED', 'Preserve baseline 8 tests; add 13 lifecycle tests'),
    ('worker-host.m4-versioned-file.test.ts', 'PREEXISTING_UNTRACKED', 'Extend existing real SDK/Worker/File E2E; deterministic event synchronization'),
    ('worker-host.m4-stage8-outcome.test.ts', 'NEW_THIS_RUN', '13 new Host/Core/real temporary filesystem tests'),
    ('runtime/src/core/tool/versioned-file-integration.test.ts', 'PREEXISTING_UNTRACKED', 'Extend existing shared-name two-View test with actual A write preserving B; no Core production edits'),
]
sources = []
for filename, origin, impact in details:
    name = filename if filename.startswith('runtime/') else source + filename
    sources.append({'path': name, 'origin': origin, 'hadUserChangesAtBaseline': origin != 'NEW_THIS_RUN',
                    'baselineSha256': baseline['files'].get(name, {}).get('sha256'), 'finalSha256': sha(root / name),
                    'impact': impact})
artifact_paths = sorted([path for path in directory.rglob('*') if path.is_file()] +
                        [stage / name for name in ['CODEX_RESULTS.md', 'GATE_STATUS.json', 'NEXT_WAVE_RECOMMENDATION.md']])
fingerprints = {
    'stage': gate['stage'], 'head': gate['head'], 'baselineIndexSha256': gate['baselineIndexSha256'],
    'finalIndexSha256': gate['finalIndexSha256'], 'sources': sources,
    'baselinePreservation': {'inventoryPath': relative(directory / 'baseline.json'),
                             'pathsChecked': integrity['baselinePathCount'],
                             'changedPreexistingPaths': integrity['baselineFilesChanged'],
                             'unchangedBaselinePaths': integrity['baselinePathCount'] - len(integrity['baselineFilesChanged']),
                             'unexpectedChanges': [], 'scope': integrity['scope']},
    'artifacts': [{'path': relative(path), 'sha256': sha(path), 'origin': 'NEW_THIS_RUN'} for path in artifact_paths],
    'selfHashPolicy': 'This manifest excludes itself to avoid a recursive digest. All listed digests are exact file bytes at packet generation.',
}
(stage / 'source-fingerprints.json').write_text(json.dumps(fingerprints, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'finalTests': {name: by_name[name]['tests'] for name in final_names},
                  'sourceFiles': len(sources), 'artifactFiles': len(artifact_paths),
                  'indexUnchanged': gate['indexUnchanged'], 'recommendation': gate['goNoGo']['stage8Limited']}, indent=2))
