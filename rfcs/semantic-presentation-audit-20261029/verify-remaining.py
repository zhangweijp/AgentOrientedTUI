from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
REPORT = Path(__file__).resolve().parent / 'repair-verification/attempt-2'
ISOLATED = Path((REPORT / 'isolation.txt').read_text().strip())
facts = json.loads((REPORT / 'results.json').read_text())
changed_test = Path('sdk/src/projection-coordinator.test.ts')
shutil.copy2(ROOT / changed_test, ISOLATED / changed_test)
files = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, text=True).splitlines() + ['runtime/src/adapters/view-message.ts']
fingerprints = {}
for name in files:
    if (ISOLATED / name).is_file():
        actual = hashlib.sha256((ISOLATED / name).read_bytes()).hexdigest()
        assert actual == hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), 'Copy is stale: ' + name
        fingerprints[name] = actual
(REPORT / 'verified-source-sha256.json').write_text(json.dumps(fingerprints, indent=2))
env = dict(os.environ, AOTUI_REF_COMPAT_BASELINE=str(ROOT / 'rfcs/sdk-runtime-delivery/w00-20261024T090930Z'), AOTUI_W08_B2_BASELINE=str(ROOT / 'rfcs/sdk-runtime-delivery/w08-b1-20261026T054703Z'))
for key in list(env):
    if key.startswith('AOTUI_') and ('FACTS' in key or key in ['AOTUI_DATA_DIR', 'AOTUI_IDE_CONSUMER', 'AOTUI_SYSTEM_INSTRUCTION_PATH']):
        env.pop(key)
for label, directory, command in [
    ('sdk-tests-fixed-ui-expectation', 'sdk', ['./node_modules/.bin/vitest', 'run']),
    ('ide-tests', 'demo-apps/aotui-ide', ['npm', 'test', '--', '--runInBand']),
    ('host-worker-e2e', 'host', ['node', '--import', 'tsx', 'test/semantic-host.e2e.ts', str(REPORT / 'host-worker-facts.json')]),
    ('ide-edges-e2e', 'demo-apps/aotui-ide', ['node', 'tests/scoped-ide-edges.mjs', str(REPORT / 'ide-edges-facts.json')]),
    ('ide-capacity-e2e', 'demo-apps/aotui-ide', ['node', 'tests/scoped-ide-capacity.mjs', str(REPORT / 'ide-capacity-facts.json')]),
]:
    started = time.time()
    with (REPORT / (label + '.log')).open('w') as log:
        result = subprocess.run(command, cwd=ISOLATED / directory, stdout=log, stderr=subprocess.STDOUT, timeout=300, env=env)
    row = {'label': label, 'cwd': directory, 'command': command, 'exit': result.returncode, 'seconds': round(time.time() - started, 2)}
    facts['checks'].append(row)
    (REPORT / 'results.json').write_text(json.dumps(facts, indent=2))
    print(json.dumps(row), flush=True)
    if result.returncode:
        print((REPORT / (label + '.log')).read_text()[-8000:], flush=True)
        break
