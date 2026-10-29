import datetime
import difflib
import hashlib
import json
import pathlib
import re
import shlex
import subprocess
import sys

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
baseline = json.loads((directory / 'baseline-readonly/inventory.json').read_text())
new_source = [
    'runtime/src/core/tool/ref-declarations.ts',
    'runtime/src/core/tool/ref-declarations.wave2c.test.ts',
    'runtime/src/engine/app/worker-host.wave2c-declarations.test.ts',
    'sdk/src/ref-declarations.wave2c.test.ts',
]
source = baseline['plannedTouch'] + new_source
docs = [str((directory / name).relative_to(root)) for name in
        ['APPROVED_SCOPE.md', 'CONTRACT.md', 'CODEX_WAVE2C_RESULTS.md', 'NEXT_MINIMAL_SLICE.md']]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(name, data):
    with (directory / name).open('w') as output:
        output.write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

if sys.argv[1] == 'patch':
    parts = []
    for name in source + docs:
        existing = name in baseline['files'] and not baseline['files'][name].get('missing')
        before = (directory / 'baseline-readonly/sources' / name).read_text() if existing else ''
        after = (root / name).read_text()
        if before == after:
            continue
        a, b = json.dumps('a/' + name), json.dumps('b/' + name)
        parts.append('diff --git ' + a + ' ' + b + '\n')
        if not existing:
            parts.append('new file mode 100644\n')
        parts.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                        fromfile=a if existing else '/dev/null', tofile=b))
    with (directory / 'incremental-changes.patch').open('w') as output:
        output.write(''.join(parts))
    print(json.dumps({'patchPaths': source + docs, 'sha256': sha(directory / 'incremental-changes.patch')}))
    sys.exit(0)

integrity = json.loads((directory / 'integrity-after-order.json').read_text())
if not integrity['ok']:
    raise SystemExit('Protection failed; stop without changing the index')
commands = []
for line in (directory / 'commands.jsonl').read_text().splitlines():
    item = json.loads(line)
    text = re.sub(r'\x1b\[[0-9;]*m', '', (root / item['log']).read_text())
    footer = re.search(r'^EXIT_CODE: (-?\d+)$', text, re.M)
    if not footer or int(footer.group(1)) != item['exitCode']:
        raise SystemExit('Raw log footer mismatch: ' + item['name'])
    tests = re.search(r'^\s*Tests:?\s+(.+)$', text, re.M)
    files = re.search(r'^\s*(?:Test Files|Test Suites:)\s+(.+)$', text, re.M)
    stats = {'filesPassed': None, 'filesFailed': None, 'passed': None, 'failed': None, 'skipped': None, 'todo': None}
    if tests:
        for key in ['passed', 'failed', 'skipped', 'todo']:
            match = re.search(r'(\d+) ' + key, tests.group(1))
            stats[key] = int(match.group(1)) if match else 0
    if files:
        for key in ['Passed', 'Failed']:
            match = re.search(r'(\d+) ' + key.lower(), files.group(1))
            stats['files' + key] = int(match.group(1)) if match else 0
    item.update({'commandText': shlex.join(item['command']), 'statistics': stats})
    violations = re.search(r'(?:REAL_WORKER_)?VIOLATIONS=(\d+)/(\d+)', text)
    if violations:
        item.update({'violations': int(violations.group(1)), 'raceCases': int(violations.group(2))})
    commands.append(item)

by_name = {item['name']: item for item in commands}
final_names = ['final-wave2c-canonical-' + name for name in
               ['runtime-tsc', 'sdk-tsc', 'ide-tsc', 'runtime-vitest', 'sdk-vitest', 'ide-jest']]
final = [by_name[name] for name in final_names]
stability = [by_name['canonical-stability-' + str(n)] for n in range(1, 4)]
required = final + stability + [by_name[name] for name in
            ['canonical-r1-original-real-worker', 'canonical-r1-original-controlled', 'protection-after-order', 'patch-check-after-order']]
if any(item['exitCode'] != 0 for item in required):
    raise SystemExit('Final checks incomplete or failed')
ordered = [item['name'] for item in commands if item['name'].startswith('final-wave2c-canonical-')] == final_names
if not ordered:
    raise SystemExit('Required full-regression order mismatch')

gate = {
    'stage': 'Wave 2C - authoritative Ref declaration preservation and misuse refusal',
    'status': 'LIMITED_PASS_REQUESTED_PENDING_CHATGPT_REVIEW',
    'generatedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head': integrity['head'], 'node': baseline['versions']['node'], 'pnpm': baseline['versions']['pnpm'],
    'stagedFingerprintDefinition': integrity['stagedFingerprintDefinition'],
    'baselineStagedDiffSha256': integrity['baselineStagedDiffSha256'],
    'finalStagedDiffSha256': integrity['finalStagedDiffSha256'],
    'baselineWorkerHostSha256': integrity['hostBaselineSha256'], 'finalWorkerHostSha256': integrity['hostFinalSha256'],
    'productionFilesModifiedFromBatchBaseline': integrity['changedExistingFiles'],
    'productionFilesAdded': [new_source[0]], 'newTestFiles': new_source[1:],
    'newCases': {'runtimeCore': 39, 'runtimeRealSDKWorker': 10, 'sdk': 14, 'total': 63},
    'finalFullRegressionNames': final_names, 'finalFullRegressionOrdered': ordered,
    'allRequiredFinalChecksZeroExit': True,
    'tests': commands,
    'threeRoundStability': stability,
    'redGreen': {
        'initialCore': by_name['red-core']['statistics'],
        'initialSDK': by_name['red-sdk']['statistics'],
        'initialRealWorker': by_name['red-worker']['statistics'],
        'outerMetadataGetters': by_name['red-outer-metadata-getters']['statistics'],
        'requiredParameterOrder': by_name['red-required-order']['statistics'],
        'implementationTscFailure': 'TS2345 callback narrowing; fixed with a const, no compiler flag change',
        'firstFullSDKFailure': 'new preflight changed existing getter message; original expectation retained, original JSON message restored',
        'rawFailuresPreserved': True,
    },
    'contractCases': [
        {'case': 'opt-in/version/optional refType survives actual SDK -> Registry -> V2 Snapshot', 'status': 'PASS_REAL_SDK_WORKER'},
        {'case': 'illegal types/versions/positions/combinations/JSON accessors/budgets', 'status': 'PASS_CORE_AND_SDK',
         'limits': 'existing JSON/Schema budgets only; no expanded args budget'},
        {'case': 'canonical conflict atomicity/equivalent order/binding revocation', 'status': 'PASS_CORE_SDK_WORKER'},
        {'case': 'missing/unknown declaration support rejects before registration', 'status': 'PASS_SIMULATED_OLD_PORT_WITH_REAL_PREACT_APPKERNEL',
         'oldRuntimeBinaryExecuted': False},
        {'case': 'Legacy and mutating/default-mutating opt-in refused', 'status': 'PASS_SDK_AND_DIRECT_REGISTRATION'},
        {'case': 'Host refuses declared Tool before policy or invocation; optional absence is still refused', 'status': 'PASS_REAL_SDK_WORKER',
         'authorizationCalls': 0, 'declaredToolDispatches': 0, 'declaredHandlerCalls': 0},
        {'case': 'old invocation straight to new Worker / stripped annotation / old source', 'status': 'PASS_REAL_SDK_WORKER',
         'declaredHandlerCalls': 0, 'oldHostBinaryExecuted': False},
        {'case': 'unannotated literal JSON/SDK validation/business success:false', 'status': 'PASS_REAL_SDK_WORKER_AND_FULL_REGRESSION'},
        {'case': 'original R1 scripts', 'status': 'PASS', 'realWorkerViolations': 0, 'realWorkerCases': 4,
         'controlledViolations': 0, 'controlledCases': 10},
    ],
    'scope': {
        'declarationSDKAPIAdded': True, 'versionedSchemaSemanticSubcontractAdded': True,
        'snapshotV1V2ExactEnvelopeFieldsChanged': False, 'snapshotSchemaVersionChanged': False,
        'refArgumentResolutionImplemented': False, 'resolveRefUsedToExpandArgs': False,
        'provenanceAuthorizationImplemented': False, 'executionIPCOrInitChanged': False,
        'typedRefRegistrationSPIChanged': False, 'defaultRouterChanged': False,
        'defaultExperimentalFlagsChanged': False, 'strictFlagsChanged': False,
        'dependenciesAdded': False, 'subAgentsStarted': False, 'networkRequestsMade': False,
    },
    'performance': {'status': 'NOT_TESTED', 'cpu': None, 'heap': None, 'p50': None, 'p95': None},
    'coverage': {'status': 'NOT_TESTED', 'percent': None},
    'oldBinaryCompatibilityMatrix': 'NOT_TESTED; simulated old port and old message shape separately tested',
    'typescriptScope': 'Original production tsconfig scopes retained; Runtime excludes .test.ts. Do not claim all test source was typechecked.',
    'protection': integrity,
    'goNoGo': {'declarationOnly': 'LIMITED_PASS_REQUESTED', 'actualRefExecution': 'NO_GO',
               'fullM4': 'NO_GO', 'strict': 'NO_GO', 'defaultAgentRouterSwitch': 'NO_GO', 'newMutatingTools': 'NO_GO'},
    'blockersForActualExecution': [
        'No approved/implemented versioned invocation and execution capability negotiation',
        'No effective args/provenance policy or pinned V2 Ref expansion implementation',
        'SDK receivedArgs may echo expanded payload in a future execution mode; error-output contract needs a sentinel test before enablement',
        'Expanded args/provenance budgets and actual Ref execution E2E remain unimplemented/untested',
    ],
    'recommendation': 'Wave 2C 声明保留与误用拒绝 LIMITED PASS，等待 ChatGPT 验收',
}
write('GATE_STATUS.json', gate)

tracked = set(subprocess.check_output(['git', 'ls-files', '-z', '--cached'], cwd=root).decode().split('\0')) - {''}
staged_before = (directory / 'baseline-readonly/index.patch').read_text()
unstaged_before = (directory / 'baseline-readonly/worktree.patch').read_text()
fingerprints = []
for name in source:
    before = baseline['files'].get(name)
    header = 'diff --git a/' + name + ' b/' + name
    fingerprints.append({
        'path': name, 'baselineSha256': before['sha256'] if before and not before.get('missing') else None,
        'finalSha256': sha(root / name),
        'origin': 'PREEXISTING_WORKTREE_MODIFIED_THIS_BATCH' if before else 'NEW_THIS_BATCH',
        'gitTrackedAtBaseline': name in tracked if before else False,
        'preexistingStagedDiff': header in staged_before if before else False,
        'preexistingUnstagedDiff': header in unstaged_before if before else False,
        'preexistingUntracked': bool(before and name not in tracked),
        'impact': 'test only' if name.endswith('.test.ts') else 'declaration preservation / refusal only',
    })

manifest = {
    'stage': gate['stage'], 'head': gate['head'],
    'baselineStagedDiffSha256': gate['baselineStagedDiffSha256'], 'finalStagedDiffSha256': gate['finalStagedDiffSha256'],
    'baselineInventorySha256': sha(directory / 'baseline-readonly/inventory.json'),
    'baselinePathRecords': integrity['baselinePathRecords'], 'baselineMissingPaths': integrity['baselineMissingPaths'],
    'unexpectedExistingChanges': integrity['unexpectedExistingChanges'],
    'sourceFiles': fingerprints,
    'incrementalPatch': {'paths': source + docs, 'sha256': sha(directory / 'incremental-changes.patch'),
                         'baseline': 'batch-start source backups, not HEAD/index',
                         'excludes': 'raw logs, machine manifests, baseline and helper scripts; all fingerprinted separately'},
    'evidenceFiles': [{'path': str(path.relative_to(root)), 'sha256': sha(path), 'sizeBytes': path.stat().st_size}
                      for path in sorted(directory.rglob('*')) if path.is_file() and path.name != 'source-fingerprints.json'],
    'selfHash': None, 'selfHashReason': 'Manifest excludes itself to avoid recursive hashing.',
}
write('source-fingerprints.json', manifest)
print(json.dumps({'status': gate['status'], 'sourcePaths': len(source), 'logs': len(list(directory.glob('test-*.log'))),
                  'finalStagedDiffSha256': gate['finalStagedDiffSha256'],
                  'unexpectedExistingChanges': integrity['unexpectedExistingChanges'],
                  'fingerprintedEvidenceFiles': len(manifest['evidenceFiles'])}, ensure_ascii=False))
