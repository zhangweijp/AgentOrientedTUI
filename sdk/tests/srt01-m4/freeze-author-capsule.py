"""Offline replacement-input preparation. This program never calls a model."""
from pathlib import Path
import argparse, copy, hashlib, json, subprocess, tarfile

p = argparse.ArgumentParser()
p.add_argument('authors', type=Path)
p.add_argument('audit', type=Path)
p.add_argument('output', type=Path)
p.add_argument('--compiler-root', type=Path, required=True)
p.add_argument('--node', default='node')
p.add_argument('--fixed-sdk-tar', type=Path, required=True)
p.add_argument('--fixed-runtime-tar', type=Path, required=True)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
audit = json.loads(a.audit.read_text())
assert (audit['semanticPassed'], audit['publicInputCompliant']) == (9, 6)
materials, archive_files, package_records = {}, {}, []

def sha(data):
    return hashlib.sha256(data).hexdigest()


def compiler_identity(root, version, node):
    root = root.resolve()
    package = json.loads((root / 'package.json').read_text())
    assert package['name'] == 'typescript' and package['version'] == version
    # Use the installed launcher's own platform resolver, including pnpm layouts.
    probe = r"""
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const getExePath = (await import(pathToFileURL(path.join(root, 'lib/getExePath.js')).href)).default;
const executable = fs.realpathSync(getExePath());
const nativeRoot = path.dirname(path.dirname(executable));
console.log(JSON.stringify({ platform: process.platform, arch: process.arch,
    nodeVersion: process.version, nodeExecutable: process.execPath,
    nativeRoot, executable, expectedPackage: '@typescript/typescript-' + process.platform + '-' + process.arch }));
"""
    resolved = json.loads(subprocess.check_output(
        [node, '--input-type=module', '-e', probe, str(root)], text=True, timeout=30))
    native_root, executable = Path(resolved['nativeRoot']), Path(resolved['executable'])
    native_manifest = native_root / 'package.json'
    native_package = json.loads(native_manifest.read_text())
    assert native_package['name'] == resolved['expectedPackage']
    assert native_package['version'] == version
    assert resolved['platform'] in native_package['os'] and resolved['arch'] in native_package['cpu']
    assert package['optionalDependencies'][native_package['name']] == version
    assert executable.relative_to(native_root).as_posix() == ('lib/tsc.exe' if resolved['platform'] == 'win32' else 'lib/tsc')
    version_output = subprocess.check_output([str(executable), '--version'], text=True, timeout=30).strip()
    assert version_output == 'Version ' + version
    files = [root / name for name in ['package.json', 'bin/tsc', 'lib/tsc.js', 'lib/getExePath.js']]
    return {'version': version, 'files': [{'path': str(f.relative_to(root)), 'sha256': sha(f.read_bytes())} for f in files],
            'native': {**resolved, 'packageName': native_package['name'], 'version': native_package['version'],
                       'versionOutput': version_output,
                       'files': [{'path': str(f.relative_to(native_root)), 'bytes': f.stat().st_size,
                                  'sha256': sha(f.read_bytes())} for f in [native_manifest, executable]]}}

for package, identity in audit['packages'].items():
    tar = a.authors / 'artifacts' / identity['tar']
    assert sha(tar.read_bytes()) == identity['sha256']
    with tarfile.open(tar) as tf:
        payload = {m.name.removeprefix('package/'): tf.extractfile(m).read()
                   for m in tf.getmembers() if m.isfile() and m.name.startswith('package/')}
    archive_files[package] = payload
    package_records.append({'package': package, **identity})
    for name, data in payload.items():
        key = package + '/' + name
        if name == 'package.json' or key in audit['reachableDeclarations'] or (
                package == '@aotui/sdk' and (name == 'README.md' or name.startswith('docs/'))):
            materials[key] = data

records = [{'path': k, 'bytes': len(v), 'sha256': sha(v)} for k, v in sorted(materials.items())]
manifest = {'state': 'sealed offline input; new model calls authorized: 0',
            'model': 'gpt-6-astra', 'reasoning': 'max', 'tools': [],
            'packages': package_records, 'materials': records,
            'declarationReachabilityParents': audit['reachabilityParents']}


def check_packet(packet):
    assert packet['model'] == manifest['model'] and packet['reasoning'] == manifest['reasoning']
    assert packet['tools'] == [] and packet['filesystemTools'] is False
    assert packet['authorizedNewModelCalls'] == 0
    assert packet['taskSha256'] == sha((a.authors / packet['originalCell'] / 'TASK.md').read_bytes())
    assert packet['taskText'].encode() == (a.authors / packet['originalCell'] / 'TASK.md').read_bytes()
    assert len(packet['materials']) == len(records)
    assert len({m['path'] for m in packet['materials']}) == len(records)
    for item in packet['materials']:
        assert '..' not in Path(item['path']).parts
        assert item['path'] in materials
        assert item['text'].encode() == materials[item['path']]
        assert sha(item['text'].encode()) == item['sha256']
    if packet['originalCell'].startswith('task-3'):
        # The starter is taken from the original public task fixture, never from an invalid answer.
        assert packet['starterSha256'] == sha(packet['starterText'].encode())
    return True

starter = Path(__file__).parent / 'author-eval/broken-app.tsx'
assert sha(starter.read_bytes()) == '907e782d550e041e59c3340b947dbec91192f729337234f715d874caf2c088f9'
packets = []
for cell in ['task-2-2', 'task-2-3', 'task-3-2']:
    task = (a.authors / cell / 'TASK.md').read_bytes()
    packet = {'originalCell': cell, 'replacementCell': 'replacement-' + cell,
              'model': manifest['model'], 'reasoning': manifest['reasoning'],
              'authorizedNewModelCalls': 0, 'tools': [], 'filesystemTools': False,
              'taskSha256': sha(task), 'taskText': task.decode(),
              'environmentWrapper': 'Only the supplied public text is available. No files, shell, browsing or tools are provided. Return the complete application source as text. External validation compiles and executes it. The original task text is preserved; its local-file/compile instructions are superseded only by this environment boundary. At most two external repair feedback turns are permitted after authorization.',
              'materials': [{'path': k, 'sha256': sha(v), 'text': v.decode()} for k, v in sorted(materials.items())]}
    if cell.startswith('task-3'):
        packet['starterText'] = starter.read_text()
        packet['starterSha256'] = sha(starter.read_bytes())
    assert check_packet(packet)
    data = (json.dumps(packet, ensure_ascii=False, indent=2) + '\n').encode()
    (a.output / (packet['replacementCell'] + '.json')).write_bytes(data)
    packets.append({'cell': packet['replacementCell'], 'originalTaskSha256': sha(task), 'packetSha256': sha(data), 'bytes': len(data)})

checks = []
def reject(name, mutate):
    packet = copy.deepcopy(packet_template)
    mutate(packet)
    try:
        check_packet(packet)
    except (AssertionError, KeyError):
        checks.append({'case': name, 'rejected': True})
    else:
        raise AssertionError('Boundary accepted ' + name)

packet_template = json.loads((a.output / 'replacement-task-2-2.json').read_text())
for key in ['@aotui/sdk/dist/tools/typebox-schema.d.ts', '@aotui/runtime/dist/worker-runtime/app-kernel/AppKernel.d.ts']:
    assert key not in materials
    package = next(n for n in archive_files if key.startswith(n + '/'))
    data = archive_files[package][key[len(package) + 1:]]
    reject('private declaration injection: ' + key,
           lambda x, k=key, v=data: x['materials'].__setitem__(0, {'path': k, 'sha256': sha(v), 'text': v.decode()}))
reject('parent traversal', lambda x: x['materials'][0].__setitem__('path', '../sdk/src/index.ts'))
reject('absolute private path', lambda x: x['materials'][0].__setitem__('path', '/repository/sdk/src/index.ts'))
reject('material body tampering', lambda x: x['materials'][0].__setitem__('text', 'different bytes'))
reject('original task tampering', lambda x: x.__setitem__('taskText', 'different task'))
reject('filesystem tool capability', lambda x: x.__setitem__('filesystemTools', True))
reject('shell tool injection', lambda x: x.__setitem__('tools', [{'name': 'exec_command'}]))
reject('model identity drift', lambda x: x.__setitem__('model', 'different-model'))
reject('premature model authorization', lambda x: x.__setitem__('authorizedNewModelCalls', 3))

validators = a.output / 'validators'
validators.mkdir(exist_ok=True)
original = (a.authors / 'task-1-1/check.mjs').read_bytes()
for name in ['original-check.mjs', 'fixed-package-check.mjs']:
    (validators / name).write_bytes(original)
compiler_hashes = []
for alias, version in [('typescript', '7.0.2')]:
    root = a.compiler_root / alias
    compiler_hashes.append(compiler_identity(root, version, a.node))
profiles = {'validatorSha256': sha(original), 'validatorCopiesIdentical': True,
            'originalProfile': {'sdkSha256': audit['packages']['@aotui/sdk']['sha256'], 'runtimeSha256': audit['packages']['@aotui/runtime']['sha256']},
            'fixedProfile': {'state': 'exact repaired M4 artifacts for deterministic validation only', 'sdkSha256': sha(a.fixed_sdk_tar.read_bytes()), 'runtimeSha256': sha(a.fixed_runtime_tar.read_bytes()), 'sameGeneratedSource': True},
            'typeScript': compiler_hashes,
            'compilerOptions': {'strict': True, 'exactOptionalPropertyTypes': True, 'skipLibCheck': False}}
(a.output / 'validator-profiles.json').write_text(json.dumps(profiles, indent=2) + '\n')
manifest['packets'] = packets
manifest['retainedOriginalCells'] = ['task-1-1', 'task-1-2', 'task-1-3', 'task-2-1', 'task-3-1', 'task-3-3']
manifest['replacementCells'] = [p['cell'] for p in packets]
manifest['visibilityVsAccess'] = {'originalPrivateFilesAvailable': 'Private declarations were present in installed payloads; exports did not constrain shell file reads.', 'originalObservedPrivateDeclarationContentCases': ['task-2-2', 'task-2-3', 'task-3-2'], 'originalSemanticPassed': '9/9', 'originalPublicInputCompliant': '6/9', 'privateApiImports': '0/9', 'replacementVisibility': 'Only the packet corpus; actual no-tool transport still requires a separately verified adapter before any authorized execution.'}
(a.output / 'capsule-manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
(a.output / 'offline-boundary-checks.json').write_text(json.dumps({'passed': True, 'positivePackets': len(packets), 'negativeChecks': checks, 'newModelCalls': 0, 'transportExecuted': False}, indent=2) + '\n')
print(json.dumps({'positivePackets': len(packets), 'negativeBoundaryChecks': len(checks), 'materials': len(materials), 'newModelCalls': 0, 'transportExecuted': False}))
