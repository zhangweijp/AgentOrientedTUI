import datetime
import json
import pathlib
import shlex
import subprocess
import sys
import time

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]

def run(name, command):
    log = directory / ('test-' + name + '.log')
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    before = time.perf_counter()
    with log.open('x') as output:
        output.write('COMMAND: ' + shlex.join(command) + '\nSTART_UTC: ' + started + '\n')
        output.flush()
        result = subprocess.run(command, cwd=root, stdout=output, stderr=subprocess.STDOUT)
        output.write('\nEXIT_CODE: ' + str(result.returncode) + '\n')
    record = {'name': name, 'command': command, 'exitCode': result.returncode, 'startedUTC': started,
              'durationSeconds': time.perf_counter() - before, 'log': str(log.relative_to(root))}
    with (directory / 'commands.jsonl').open('a') as output:
        output.write(json.dumps(record) + '\n')
    print(json.dumps(record), flush=True)
    return result.returncode

if sys.argv[1] == 'baseline' or sys.argv[1] == 'final' or sys.argv[1].startswith('final-'):
    prefix = sys.argv[1]
    commands = [
        ('runtime-tsc', ['pnpm','--dir','runtime','exec','tsc','--pretty','false']),
        ('sdk-tsc', ['pnpm','--dir','sdk','exec','tsc','--noEmit','--pretty','false']),
        ('ide-tsc', ['pnpm','--dir','demo-apps/aotui-ide','exec','tsc','--noEmit','--pretty','false']),
        ('runtime-vitest', ['pnpm','--dir','runtime','exec','vitest','run','--reporter=dot']),
        ('sdk-vitest', ['pnpm','--dir','sdk','exec','vitest','run','--reporter=dot']),
        ('ide-jest', ['pnpm','--dir','demo-apps/aotui-ide','exec','jest','--runInBand']),
    ]
    codes = [run(prefix + '-' + name, command) for name, command in commands]
    sys.exit(int(any(codes)))
else:
    sys.exit(run(sys.argv[1], sys.argv[2:]))
