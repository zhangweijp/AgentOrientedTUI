import pathlib
import shutil
import subprocess
import tempfile

directory = pathlib.Path(__file__).resolve().parent
sources = directory / 'baseline-readonly/sources'
with tempfile.TemporaryDirectory(prefix='aotui-wave2c-patch-check-') as temp:
    target = pathlib.Path(temp)
    for path in sources.rglob('*'):
        if path.is_file():
            dest = target / path.relative_to(sources)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)
    result = subprocess.run(['git', 'apply', '--check', str(directory / 'incremental-changes.patch')], cwd=target)
    print('PATCH_CHECK_EXIT_CODE=' + str(result.returncode))
    raise SystemExit(result.returncode)
