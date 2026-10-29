"""Build/test an isolated copy against local dependencies; never replace shared dist."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
BASE_REPORT = Path(__file__).resolve().parent / 'repair-verification'
BASE_REPORT.mkdir(exist_ok=True)
REPORT = BASE_REPORT / ('attempt-' + str(len(list(BASE_REPORT.glob('attempt-*'))) + 1))
REPORT.mkdir()
ISOLATED = Path(tempfile.mkdtemp(prefix='aotui-presentation-repair-', dir='/private/tmp'))
PACKAGES = ['agent-driver-v2', 'runtime', 'sdk', 'demo-apps/aotui-ide', 'demo-apps/terminal-app', 'demo-apps/lite-browser-app', 'host']

def fingerprint():
    result = {}
    for package in PACKAGES:
        for file in sorted((ROOT / package / 'dist').rglob('*')):
            if file.is_file():
                result[str(file.relative_to(ROOT))] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result

before = fingerprint()
(REPORT / 'shared-dist-before.json').write_text(json.dumps(before, indent=2))
for package in PACKAGES:
    shutil.copytree(ROOT / package, ISOLATED / package, ignore=shutil.ignore_patterns('node_modules', 'dist', 'dist-gui', 'release', '.env', '.env.*', '*.tsbuildinfo', '.DS_Store', 'coverage'))
for package in ['planning-app', 'token-monitor-app']:
    target = ISOLATED / 'demo-apps' / package / 'src/tui/RootView.tsx'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'demo-apps' / package / 'src/tui/RootView.tsx', target)
shutil.copytree(ROOT / 'scripts', ISOLATED / 'scripts')
shutil.copy2(ROOT / 'package.json', ISOLATED / 'package.json')
# Dependencies are reused read-only; every @aotui package resolves into this copy.
for package in [''] + PACKAGES:
    src = ROOT / package / 'node_modules'
    dst = ISOLATED / package / 'node_modules'
    if not src.is_dir():
        continue
    dst.mkdir(parents=True, exist_ok=True)
    for entry in src.iterdir():
        if entry.name in ['@aotui', '.cache', '.vite', '.vite-temp']:
            continue
        (dst / entry.name).symlink_to(entry.resolve(), target_is_directory=entry.is_dir())
    (dst / '@aotui').mkdir(exist_ok=True)
    for name in ['runtime', 'sdk', 'agent-driver-v2']:
        (dst / '@aotui' / name).symlink_to(ISOLATED / name, target_is_directory=True)

facts = {'isolation': str(ISOLATED), 'shared_dist_files': len(before), 'checks': []}
(REPORT / 'isolation.txt').write_text(str(ISOLATED) + '\n')

env = dict(os.environ, AOTUI_REF_COMPAT_BASELINE=str(ROOT / 'rfcs/sdk-runtime-delivery/w00-20261024T090930Z'), AOTUI_W08_B2_BASELINE=str(ROOT / 'rfcs/sdk-runtime-delivery/w08-b1-20261026T054703Z'))
# Do not redirect test evidence into an older delivery's output directory.
for key in list(env):
    if key.startswith('AOTUI_') and ('FACTS' in key or key in ['AOTUI_DATA_DIR', 'AOTUI_IDE_CONSUMER', 'AOTUI_SYSTEM_INSTRUCTION_PATH']):
        env.pop(key)

def run(label, directory, command, timeout=300, required=True):
    start = time.time()
    with (REPORT / (label + '.log')).open('w') as log:
        process = subprocess.run(command, cwd=ISOLATED / directory, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, env=env)
    result = {'label': label, 'cwd': directory, 'command': command, 'exit': process.returncode, 'seconds': round(time.time() - start, 2)}
    facts['checks'].append(result)
    print(json.dumps(result), flush=True)
    (REPORT / 'results.json').write_text(json.dumps(facts, indent=2))
    if process.returncode:
        print((REPORT / (label + '.log')).read_text()[-7000:], flush=True)
        if required: raise RuntimeError(label)

try:
    for package in PACKAGES:
        run('build-' + package.replace('/', '-'), package, ['npm', 'run', 'build'])
    run('runtime-tests', 'runtime', ['./node_modules/.bin/vitest', 'run'], required=False)
    run('sdk-tests', 'sdk', ['./node_modules/.bin/vitest', 'run'])
    run('ide-tests', 'demo-apps/aotui-ide', ['npm', 'test', '--', '--runInBand'])
    run('host-worker-e2e', 'host', ['node', '--import', 'tsx', 'test/semantic-host.e2e.ts', str(REPORT / 'host-worker-facts.json')])
    run('ide-edges-e2e', 'demo-apps/aotui-ide', ['node', 'tests/scoped-ide-edges.mjs', str(REPORT / 'ide-edges-facts.json')])
    run('ide-capacity-e2e', 'demo-apps/aotui-ide', ['node', 'tests/scoped-ide-capacity.mjs', str(REPORT / 'ide-capacity-facts.json')])
finally:
    facts['shared_dist_unchanged'] = fingerprint() == before
    (REPORT / 'results.json').write_text(json.dumps(facts, indent=2))
    print(json.dumps({'shared_dist_unchanged': facts['shared_dist_unchanged'], 'isolation': str(ISOLATED)}), flush=True)
