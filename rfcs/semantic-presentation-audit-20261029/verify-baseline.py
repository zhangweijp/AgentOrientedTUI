"""Compare pre-existing failures using HEAD code and the same dependency layout."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REPORT = Path(__file__).resolve().parent / 'repair-verification/baseline-head'
REPORT.mkdir(exist_ok=True)
source = Path((REPORT.parent / 'attempt-1/isolation.txt').read_text().strip())
baseline = Path(tempfile.mkdtemp(prefix='aotui-presentation-baseline-', dir='/private/tmp')) / 'repo'
shutil.copytree(source, baseline, symlinks=True)
changed = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, text=True).splitlines()
for relative in changed:
    target = baseline / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(subprocess.check_output(['git', 'show', 'HEAD:' + relative], cwd=ROOT))
for modules in [baseline / 'node_modules'] + [baseline / p / 'node_modules' for p in ['runtime', 'sdk', 'agent-driver-v2', 'host', 'demo-apps/aotui-ide', 'demo-apps/terminal-app', 'demo-apps/lite-browser-app']]:
    for name in ['runtime', 'sdk', 'agent-driver-v2']:
        link = modules / '@aotui' / name
        link.unlink()
        link.symlink_to(baseline / name, target_is_directory=True)
facts = {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'baseline': str(baseline), 'restored_tracked_files': changed, 'checks': []}
for label, directory, command in [
    ('runtime-build', 'runtime', ['npm', 'run', 'build']),
    ('sdk-build', 'sdk', ['npm', 'run', 'build']),
    ('existing-failures', 'runtime', ['./node_modules/.bin/vitest', 'run', 'src/kernel/interaction-e2e.test.ts', 'src/adapters/snapshot/shadow-receiver.test.ts']),
]:
    with (REPORT / (label + '.log')).open('w') as log:
        result = subprocess.run(command, cwd=baseline / directory, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    facts['checks'].append({'label': label, 'cwd': directory, 'command': command, 'exit': result.returncode})
    print(json.dumps(facts['checks'][-1]), flush=True)
    if result.returncode and label != 'existing-failures':
        print((REPORT / (label + '.log')).read_text()[-5000:]); break
(REPORT / 'results.json').write_text(json.dumps(facts, indent=2))
