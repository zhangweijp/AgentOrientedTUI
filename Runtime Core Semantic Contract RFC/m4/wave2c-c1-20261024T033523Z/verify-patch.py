import pathlib
import shutil
import subprocess
import tempfile

directory = pathlib.Path(__file__).resolve().parent
sources = directory / 'baseline-source'
with tempfile.TemporaryDirectory(prefix='aotui-wave2c-c1-patch-') as temp:
    target = pathlib.Path(temp)
    for source in sources.rglob('*'):
        if source.is_file():
            destination = target / source.relative_to(sources)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
    result = subprocess.run(['git', 'apply', '--check', str(directory / 'incremental-changes.patch')], cwd=target)
    print('PATCH_CHECK_EXIT_CODE=' + str(result.returncode))
    raise SystemExit(result.returncode)
