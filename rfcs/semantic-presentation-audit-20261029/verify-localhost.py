from pathlib import Path
import json
import os
import subprocess
import time

ROOT=Path(__file__).resolve().parents[2]
REPORT=Path(__file__).resolve().parent/'repair-verification/attempt-2'
ISOLATED=Path((REPORT/'isolation.txt').read_text().strip())
command=['node','--import','tsx','test/semantic-host.e2e.ts',str(REPORT/'host-worker-facts.json')]
env=dict(os.environ)
for key in list(env):
    if key.startswith('AOTUI_'): env.pop(key)
start=time.time()
with (REPORT/'host-worker-e2e-localhost.log').open('w') as log:
    result=subprocess.run(command,cwd=ISOLATED/'host',env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
facts=json.loads((REPORT/'results.json').read_text())
row={'label':'host-worker-e2e-localhost','cwd':'host','command':command,'exit':result.returncode,'seconds':round(time.time()-start,2),'local_fixture':'127.0.0.1 ephemeral port'}
facts['checks'].append(row)
(REPORT/'results.json').write_text(json.dumps(facts,indent=2))
print(json.dumps(row),flush=True)
print((REPORT/'host-worker-e2e-localhost.log').read_text()[-4500:],flush=True)
raise SystemExit(result.returncode)
