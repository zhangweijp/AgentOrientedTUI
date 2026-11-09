"""Recompute content exposure from immutable author events and original package declarations."""
from pathlib import Path
import argparse, hashlib, json, posixpath, re, tarfile
from collections import deque
p = argparse.ArgumentParser()
p.add_argument('authors', type=Path)
p.add_argument('output', type=Path)
a = p.parse_args()
packages = {}
for name, pattern in [('@aotui/sdk', 'aotui-sdk-0.4.0-srt01-m4.1-*'),
                      ('@aotui/runtime', 'aotui-runtime-3.0.0-6a2d*'),
                      ('@aotui/agent-driver-v2', 'aotui-agent-driver-v2-*')]:
    tar = next((a.authors / 'artifacts').glob(pattern))
    with tarfile.open(tar) as archive:
        files = {m.name.removeprefix('package/'): archive.extractfile(m).read().decode('utf-8')
                 for m in archive.getmembers() if m.isfile() and
                 (m.name.endswith(('.d.ts', '.d.mts', '.d.cts')) or m.name == 'package/package.json')}
    packages[name] = {'tar': tar.name, 'sha256': hashlib.sha256(tar.read_bytes()).hexdigest(),
                      'manifest': json.loads(files['package.json']), 'files': files}

def type_entry(value):
    if isinstance(value, dict):
        if isinstance(value.get('types'), str):
            return value['types'].removeprefix('./')
        for key in ['import', 'default']:
            found = type_entry(value.get(key))
            if found:
                return found
    return None

roots, reached = [], {}
queue = deque()
for name, package in packages.items():
    for export, value in package['manifest'].get('exports', {}).items():
        target = type_entry(value)
        if target:
            key = name + '/' + target
            roots.append({'export': name + export.removeprefix('.'), 'file': key})
            queue.append((name, target, None))
    if not package['manifest'].get('exports') and package['manifest'].get('types'):
        queue.append((name, package['manifest']['types'].removeprefix('./'), None))
imports = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]''')
while queue:
    name, file, parent = queue.popleft()
    key = name + '/' + file
    if key in reached:
        continue
    assert file in packages[name]['files'], key
    reached[key] = parent
    source = re.sub(r'/\*[\s\S]*?\*/|//[^\n]*', '', packages[name]['files'][file])
    for specifier in imports.findall(source):
        package_name, target = name, None
        if specifier.startswith('.'):
            base = posixpath.normpath(posixpath.join(posixpath.dirname(file), specifier))
            candidates = [base]
            if base.endswith('.js'):
                candidates.insert(0, base[:-3] + '.d.ts')
            elif base.endswith('.mjs'):
                candidates.insert(0, base[:-4] + '.d.mts')
            else:
                candidates.extend([base + '.d.ts', base + '/index.d.ts'])
            target = next((x for x in candidates if x in packages[name]['files']), None)
        else:
            for other in packages:
                if specifier == other or specifier.startswith(other + '/'):
                    package_name = other
                    subpath = '.' + specifier[len(other):]
                    manifest = packages[other]['manifest']
                    target = type_entry(manifest.get('exports', {}).get(subpath))
                    if target is None and subpath == '.':
                        target = manifest.get('types', '').removeprefix('./') or None
                    break
        if target:
            queue.append((package_name, target, key))

path_pattern = r'node_modules/(@aotui/(?:sdk|runtime)/[^\s\'";]+?\.d\.(?:ts|mts|cts))'
literal_path = re.compile(path_pattern)
grep_line = re.compile('^' + path_pattern + r':(\d+):(.*)$')
results = []
for case in sorted(a.authors.glob('task-*')):
    events_file = case / 'attempt-0/events.jsonl'
    if not events_file.exists():
        continue
    content_reads, path_listings, commands = [], [], []
    for number, line in enumerate(events_file.read_text().splitlines(), 1):
        if not line.startswith('{'):
            continue
        event = json.loads(line)
        item = event.get('item', {})
        if event.get('type') != 'item.completed' or item.get('type') != 'command_execution':
            continue
        command, output = item.get('command', ''), item.get('aggregated_output', '')
        commands.append({'eventLine': number, 'itemId': item.get('id'), 'command': command,
                         'exitCode': item.get('exit_code'), 'outputSha256': hashlib.sha256(output.encode()).hexdigest()})
        for match in literal_path.finditer(command):
            file = match.group(1)
            name = next((n for n in packages if file.startswith(n + '/')), None)
            text = packages[name]['files'].get(file[len(name) + 1:]) if name else None
            # Count actual returned declaration text, not a failed cat or a filename listing.
            if text and text.strip() in output:
                content_reads.append({'file': file, 'eventLine': number, 'itemId': item.get('id'),
                                      'kind': 'complete declaration content', 'publicReachable': file in reached})
        for output_line in output.splitlines():
            match = grep_line.match(output_line)
            if match:
                file = match.group(1)
                content_reads.append({'file': file, 'declarationLine': int(match.group(2)),
                                      'eventLine': number, 'itemId': item.get('id'),
                                      'kind': 'declaration search result', 'text': match.group(3),
                                      'publicReachable': file in reached})
            elif literal_path.fullmatch(output_line):
                file = literal_path.fullmatch(output_line).group(1)
                if file not in reached:
                    path_listings.append({'file': file, 'eventLine': number, 'itemId': item.get('id')})
    private = [r for r in content_reads if not r['publicReachable']]
    source = next(case.glob('app.ts*'))
    references = re.findall(r'''(?:\bfrom\s+|\bimport\s*\(\s*)['"](@aotui/[^'"]+)['"]''', source.read_text())
    public_names = {r['export'] for r in roots}
    private_imports = [r for r in references if r not in public_names]
    result_file = case / 'result.json'
    original_result = json.loads(result_file.read_text()) if result_file.exists() else {}
    results.append({'case': case.name, 'semanticPassed': original_result.get('passed'),
                    'publicInputCompliant': not private, 'privateDeclarationContent': private,
                    'nonPublicFilenameListings': path_listings, 'publicDeclarationReads': [r for r in content_reads if r['publicReachable']],
                    'privateApiImports': private_imports, 'commands': commands,
                    'eventsSha256': hashlib.sha256(events_file.read_bytes()).hexdigest(),
                    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()})
summary = {'semanticPassed': sum(r['semanticPassed'] is True for r in results),
           'publicInputCompliant': sum(r['publicInputCompliant'] for r in results),
           'attempts': len(results), 'requiredPublicInputCompliant': 8,
           'privateApiImportCases': sum(bool(r['privateApiImports']) for r in results),
           'criterion': 'Returned declaration content must be reachable from actual public exports. Filename-only listings are disclosed separately; they do not establish declaration-content access.',
           'packages': {n: {k: v[k] for k in ['tar', 'sha256']} for n, v in packages.items()},
           'exports': roots, 'reachableDeclarations': sorted(reached), 'reachabilityParents': reached,
           'cases': results}
summary['publicInputGatePassed'] = summary['publicInputCompliant'] >= 8 and summary['semanticPassed'] == 9 and summary['privateApiImportCases'] == 0
a.output.parent.mkdir(parents=True, exist_ok=True)
a.output.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({k: summary[k] for k in ['semanticPassed', 'publicInputCompliant', 'attempts', 'privateApiImportCases']}, ensure_ascii=False))

raise SystemExit(0 if summary['publicInputGatePassed'] else 1)
