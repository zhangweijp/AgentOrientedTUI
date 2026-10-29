"""Build this design-only evidence packet from actual logs and protection audit."""
import datetime
import difflib
import hashlib
import json
import pathlib
import re
import shlex

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
baseline = json.loads((directory / 'baseline-readonly/inventory.json').read_text())
integrity = json.loads((directory / 'integrity-final.json').read_text())
if not integrity['ok']:
    raise SystemExit('Protection failed: do not issue a delivery claim')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(name, data):
    with (directory / name).open('x') as output:
        output.write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

commands = []
for line in (directory / 'commands.jsonl').read_text().splitlines():
    item = json.loads(line)
    log = root / item['log']
    content = re.sub(r'\x1b\[[0-9;]*m', '', log.read_text())
    footer = re.search(r'^EXIT_CODE: (-?\d+)$', content, re.M)
    if not footer or int(footer.group(1)) != item['exitCode']:
        raise SystemExit('Log footer mismatch: ' + log.name)
    test_line = re.search(r'^\s*Tests:?\s+(.+)$', content, re.M)
    file_line = re.search(r'^\s*(?:Test Files|Test Suites:)\s+(.+)$', content, re.M)
    stats = {'filesPassed': None, 'filesFailed': None, 'passed': None, 'failed': None, 'skipped': None, 'todo': None}
    if test_line:
        for key in ['passed', 'failed', 'skipped', 'todo']:
            count = re.search(r'(\d+) ' + key, test_line.group(1))
            stats[key] = int(count.group(1)) if count else 0
    if file_line:
        for key in ['Passed', 'Failed']:
            count = re.search(r'(\d+) ' + key.lower(), file_line.group(1))
            stats['files' + key] = int(count.group(1)) if count else 0
    violations = re.search(r'(?:REAL_WORKER_)?VIOLATIONS=(\d+)/(\d+)', content)
    item.update({'commandText': shlex.join(item['command']), 'statistics': stats})
    if violations:
        item['violations'] = int(violations.group(1))
        item['raceCases'] = int(violations.group(2))
    if item['name'] == 'current-runtime-contract':
        item['classification'] = 'TEST_AUTHORING_ERROR: expected 51 bytes, actual/independently checked 52; production unchanged'
    commands.append(item)

regression = [item for item in commands if item['name'].startswith('final-wave2b-')]
required_names = ['runtime-tsc', 'sdk-tsc', 'ide-tsc', 'runtime-vitest', 'sdk-vitest', 'ide-jest']
ordered = [item['name'] for item in regression] == ['final-wave2b-' + name for name in required_names]
all_zero = len(regression) == 6 and all(item['exitCode'] == 0 for item in regression)
if not ordered or not all_zero:
    raise SystemExit('Required regression evidence is not complete')

gate = {
    'stage': 'Wave 2B - read-only Ref argument contract DESIGN GATE',
    'generatedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'DESIGN_DELIVERED_PENDING_CHATGPT_ARCHITECTURE_REVIEW',
    'head': integrity['head'],
    'baselineIndexSha256': baseline['indexSha256'],
    'finalIndexSha256': integrity['finalIndexSha256'],
    'baselineWorkerHostSha256': baseline['files']['runtime/src/engine/app/worker-host.ts']['sha256'],
    'finalWorkerHostSha256': integrity['workerHostSha256'],
    'node': baseline['versions']['node'], 'pnpm': baseline['versions']['pnpm'],
    'productionFilesChanged': [],
    'newTestFiles': ['runtime/src/core/snapshot/ref-contract.wave2b.test.ts', 'sdk/src/ref-contract.wave2b.test.ts'],
    'scope': {'proposalImplemented': False, 'schemaChanged': False, 'publicSDKAPIChanged': False,
              'ipcChanged': False, 'defaultRouterChanged': False, 'strictFlagsChanged': False,
              'defaultExperimentalFlagsChanged': False, 'subAgentsStarted': False,
              'networkRequestsMade': False, 'dependenciesAdded': False},
    'requiredRegressionCommandsOrdered': ordered,
    'allRequiredRegressionZeroExit': all_zero,
    'tests': commands,
    'newCases': {'runtime': 17, 'sdk': 10},
    'redGreen': {'productionBugFix': 'NOT_APPLICABLE - design only, no production edit',
                 'firstProbe': '16 passed / 1 failed: test author arithmetic error (51 vs 52)',
                 'correctedProbe': 'Runtime 17 passed; SDK 10 passed',
                 'originalFailureLogPreserved': True},
    'contractCases': [
        {'case': 'same Ref id in two Views / exact owner', 'status': 'VERIFIED_CURRENT_CORE_FIXTURE'},
        {'case': 'Ref-only historical A and latest B; immutable detached payload', 'status': 'VERIFIED_CURRENT_CORE'},
        {'case': 'same viewId remount does not rebind historical selector; old execution source rejected', 'status': 'VERIFIED_CURRENT_CORE'},
        {'case': 'missing Ref / wrong owner / cross App and AppInstance', 'status': 'VERIFIED_CURRENT_CORE'},
        {'case': 'expired pin is readable data but not a fresh execution source', 'status': 'VERIFIED_CURRENT_CORE'},
        {'case': 'refType / entity filtering before new Ref dispatch', 'status': 'NOT_IMPLEMENTED',
         'observed': 'resolveRef returns these as data; it has no expected-type or permission contract'},
        {'case': 'metadata lost at reference-to-string projection / unknown Ref type', 'status': 'VERIFIED_CURRENT_ADAPTER_WITH_FIXTURES'},
        {'case': 'ordinary reference-shaped args stay literal through actual SDK/Worker',
         'status': 'VERIFIED_EXISTING_WAVE2A_TEST_RERUN - NOT proposal Ref execution'},
        {'case': 'expanded budget primitives / repeated payload cost', 'status': 'VERIFIED_CURRENT_CODEC_NOT_RESOLVER'},
        {'case': 'proposal authorization receives resolved args and provenance / rejected Handler count zero', 'status': 'NOT_IMPLEMENTED_NOT_TESTED'},
    ],
    'stability': {'additionalTargetedRounds': 1, 'files': 5, 'passed': 81, 'exitCode': 0,
                  'threeRoundStability': 'NOT_TESTED_THIS_DESIGN_BATCH'},
    'performance': {'status': 'NOT_TESTED', 'cpu': None, 'heap': None, 'p50': None, 'p95': None},
    'coverage': {'status': 'NOT_TESTED', 'percent': None},
    'newRefExecutionE2E': 'NOT_IMPLEMENTED / NOT_TESTED',
    'protection': integrity,
    'goNoGo': {'design': 'DELIVERED_FOR_REVIEW_ONLY', 'genericRefExecution': 'NO_GO',
               'fullM4': 'NO_GO', 'strict': 'NO_GO', 'defaultAgentRouterSwitch': 'NO_GO', 'mutatingTools': 'NO_GO'},
    'blockersForExecution': [
        'Authoritative reference parameter semantics are lost in current Tool projection',
        'SDK Ref projection has refType unknown; typed File matching needs separately approved registration metadata',
        'New declaration/API/SPI and versioned invocation/capability negotiation are unapproved and unimplemented',
        'Resolved-args authorization, binding provenance, expanded budgets and real SDK/Worker Ref E2E remain unimplemented',
    ],
    'recommendation': 'Wave 2B Ref 合同设计已交付，等待 ChatGPT 架构验收',
}
write('GATE_STATUS.json', gate)

test_files = [root / path for path in gate['newTestFiles']]
docs = [directory / name for name in ['CODE_FACTS.md', 'REF_CONTRACT_PROPOSAL.md', 'VALIDATION_RESULTS.md', 'NEXT_MINIMAL_SLICE.md']]
patch_files = test_files + docs
patch = []
for path in patch_files:
    name = str(path.relative_to(root))
    if name in baseline['files']:
        raise SystemExit('Incremental patch must not claim preexisting data: ' + name)
    a, b = json.dumps('a/' + name), json.dumps('b/' + name)
    patch.append('diff --git ' + a + ' ' + b + '\nnew file mode 100644\n')
    patch.extend(difflib.unified_diff([], path.read_text().splitlines(keepends=True),
                                   fromfile='/dev/null', tofile=b))
with (directory / 'incremental-changes.patch').open('x') as output:
    output.write(''.join(patch))

anchors = [
    'runtime/src/engine/app/worker-host.ts', 'runtime/src/core/tool/source-binding.ts',
    'runtime/src/core/tool/view-owned-tools.ts', 'runtime/src/core/snapshot/types.ts',
    'runtime/src/core/snapshot/validator.ts', 'runtime/src/core/snapshot/v2-validator.ts',
    'runtime/src/core/snapshot/store.ts', 'runtime/src/core/snapshot/json.ts',
    'runtime/src/worker-runtime/dom-snapshot-producer.ts', 'runtime/src/worker-runtime/index.ts',
    'runtime/src/worker-runtime/app-kernel/AppKernel.ts', 'runtime/src/spi/worker-protocol/messages.ts',
    'sdk/src/hooks/useRef.ts', 'sdk/src/hooks/useViewTypeTool.ts', 'sdk/src/utils/validateArgs.ts',
    'sdk/src/operation/types.ts', 'sdk/src/operation/defineParams.ts', 'sdk/src/components/View.tsx',
]
manifest = {
    'stage': gate['stage'], 'head': gate['head'],
    'baselineIndexSha256': gate['baselineIndexSha256'], 'finalIndexSha256': gate['finalIndexSha256'],
    'existingFileProtection': {
        'inventory': 'baseline-readonly/inventory.json',
        'inventorySha256': sha(directory / 'baseline-readonly/inventory.json'),
        'protectedCount': integrity['protectedExistingFiles'],
        'changed': integrity['changedExistingFiles'],
        'ignoredBuildOutputsExcluded': True,
    },
    'incrementalPatch': {'files': [str(path.relative_to(root)) for path in patch_files],
                         'sha256': sha(directory / 'incremental-changes.patch'),
                         'excludes': 'raw logs, machine manifests, helper scripts and baseline copies (fingerprinted separately); no prior-wave changes'},
    'sourceFiles': [{'path': str(path.relative_to(root)), 'baselineSha256': None, 'finalSha256': sha(path),
                     'origin': 'NEW_THIS_BATCH', 'impact': 'test-only; no production behavior change'} for path in test_files],
    'readOnlyProductionAnchors': [
        {'path': name, 'baselineSha256': baseline['files'][name]['sha256'], 'finalSha256': sha(root / name),
         'origin': 'PREEXISTING_WORKTREE_PRESERVED', 'changedThisBatch': False} for name in anchors
    ],
    'evidenceFiles': [
        {'path': str(path.relative_to(root)), 'sha256': sha(path), 'sizeBytes': path.stat().st_size,
         'origin': 'NEW_THIS_BATCH_EVIDENCE'}
        for path in sorted(directory.rglob('*')) if path.is_file() and path.name != 'source-fingerprints.json'
    ],
    'selfHash': None,
    'selfHashReason': 'This manifest excludes itself to avoid recursive hashing; all listed artifacts have byte SHA-256.',
}
write('source-fingerprints.json', manifest)
print(json.dumps({'gate': gate['status'], 'newTestCases': gate['newCases'],
                  'protectedExistingFiles': integrity['protectedExistingFiles'],
                  'changedExistingFiles': integrity['changedExistingFiles'],
                  'finalIndexSha256': gate['finalIndexSha256'],
                  'evidenceFilesFingerprinted': len(manifest['evidenceFiles'])}, ensure_ascii=False))
