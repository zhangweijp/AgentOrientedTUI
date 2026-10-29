import datetime
import hashlib
import json
import pathlib
import re
import shlex

directory = pathlib.Path(__file__).resolve().parent
root = directory.parents[2]
baseline = json.loads((directory / 'baseline.json').read_text())
integrity = json.loads((directory / 'integrity-final.json').read_text())
commands = [json.loads(line) for line in (directory / 'commands.jsonl').read_text().splitlines()]
assert integrity['pass']


def text_log(record):
    return re.sub(r'\x1b\[[0-9;]*m', '', (root / record['log']).read_text())


def statistics(record):
    text = text_log(record)
    if 'vitest' in record['command']:
        files = re.search(r'^\s*Test Files\s+(.+)$', text, re.M)
        tests = re.search(r'^\s*Tests\s+(.+)$', text, re.M)
        assert files and tests

        def count(line, label):
            match = re.search(r'(\d+) ' + label, line)
            return int(match[1]) if match else 0

        return {'filesPassed': count(files[1], 'passed'), 'filesFailed': count(files[1], 'failed'),
                'passed': count(tests[1], 'passed'), 'failed': count(tests[1], 'failed'),
                'skipped': count(tests[1], 'skipped'), 'todo': count(tests[1], 'todo')}
    if 'jest' in record['command']:
        suites = re.search(r'Test Suites:\s+(\d+) passed', text)
        tests = re.search(r'Tests:\s+(\d+) passed', text)
        assert suites and tests
        return {'suitesPassed': int(suites[1]), 'passed': int(tests[1]), 'failed': 0, 'skipped': 0, 'todo': 0}
    return None


for record in commands:
    assert f'EXIT_CODE: {record["exitCode"]}' in text_log(record)
    record['stats'] = statistics(record)
by_name = {record['name']: record for record in commands}
final_names = ['final-c1-' + name for name in ['runtime-tsc', 'sdk-tsc', 'ide-tsc', 'runtime-vitest', 'sdk-vitest', 'ide-jest']]
final = [by_name[name] for name in final_names]
assert [record['name'] for record in commands if record['name'].startswith('final-c1-')] == final_names
assert all(record['exitCode'] == 0 for record in final)
modified = datetime.datetime.fromtimestamp((root / baseline['plannedTouch'][0]).stat().st_mtime, datetime.timezone.utc)
assert modified < datetime.datetime.fromisoformat(final[0]['startedUTC'])
for previous, current in zip(final, final[1:]):
    end = datetime.datetime.fromisoformat(previous['startedUTC']) + datetime.timedelta(seconds=previous['durationSeconds'])
    assert end <= datetime.datetime.fromisoformat(current['startedUTC'])


def probe(name):
    text = text_log(by_name[name])
    return json.JSONDecoder().raw_decode(text[text.index('{'):])[0]


red_probe = probe('red-original-independent-v3')
green_probe = probe('green-original-independent-v3')
comparison = probe('green-ordinary-baseline-comparison')
assert red_probe['contractFailures'] == 6 and green_probe['contractFailures'] == 0
assert green_probe['totalCases'] == 10 and all(case['contractSatisfied'] for case in green_probe['cases'])
assert len(comparison['results']) == 4 and all(item['registration'] == 'accepted' and
    item['handlerCalls'] == 1 and item['invocation']['success'] is True for item in comparison['results'])
stability = [by_name['c1-stability-' + str(n)] for n in range(1, 4)]
assert all(record['exitCode'] == 0 and record['stats']['filesPassed'] == 13 and
           record['stats']['passed'] == 200 for record in stability)
r1 = []
for suffix, marker in [('real-worker', 'REAL_WORKER_VIOLATIONS'), ('controlled', 'VIOLATIONS')]:
    record = by_name['c1-r1-original-' + suffix]
    match = re.search(r'^' + marker + r'=(\d+)/(\d+)$', text_log(record), re.M)
    assert match and record['exitCode'] == 0 and int(match[1]) == 0
    r1.append({'name': record['name'], 'violations': int(match[1]), 'cases': int(match[2]), 'exitCode': record['exitCode'], 'log': record['log']})
assert by_name['red-c1-contract']['stats'] == {'filesPassed': 0, 'filesFailed': 1, 'passed': 17, 'failed': 9, 'skipped': 0, 'todo': 0}
assert by_name['green-core-contract']['stats']['passed'] == 65
assert all(record['exitCode'] == (1 if record['name'].startswith('red-') and record['name'] != 'red-initial-runtime-tsc' else 0)
           for record in commands)

sources = []
for name in baseline['plannedTouch'] + [baseline['newTest']]:
    before = baseline['files'].get(name)
    data = (root / name).read_bytes()
    sources.append({'path': name, 'origin': 'pre-existing untracked Wave 2C module' if before else 'new C1 test',
                    'baselineSha256': before['sha256'] if before else None,
                    'finalSha256': hashlib.sha256(data).hexdigest(), 'finalBytes': len(data),
                    'impact': 'Shared Ref declaration traversal only' if before else '26 Core/Registry/V2 synthetic Handler contract cases'})

gate = {
    'stage': 'Wave 2C C1 limited fix', 'head': baseline['head'],
    'baselineIndexSha256': baseline['stagedDiffSha256'], 'finalIndexSha256': integrity['finalIndexSha256'],
    'indexHashMeaning': integrity['indexHashMeaning'], 'worktreeProtection': integrity,
    'toolchain': baseline['versions'], 'productionLastModifiedUTC': modified.isoformat(),
    'allFinalChecksAfterLastProductionEdit': True, 'sixRegressionCommandsSequential': True,
    'tests': commands, 'finalRegression': final, 'stability': stability, 'originalR1': r1,
    'redGreen': {'newContractRed': by_name['red-c1-contract']['stats'],
                 'newPlusOriginalCoreGreen': by_name['green-core-contract']['stats'],
                 'independentV3Before': {'cases': red_probe['totalCases'], 'violations': red_probe['contractFailures'], 'exitCode': 1},
                 'independentV3After': {'cases': green_probe['totalCases'], 'violations': green_probe['contractFailures'], 'exitCode': 0},
                 'ordinarySchemaBaselineComparison': comparison},
    'securityCases': {
        'misplacedDependencyDeclarations': {'status': 'PASS', 'evidenceLayer': 'Real Core Registry + V2 validator + synthetic Handler',
            'cases': [case for case in green_probe['cases'] if case['expected'] == 'reject']},
        'plainDependencyCompatibility': {'status': 'PASS', 'historicalComparison': 'Saved baseline Registry transpiled in memory with current unchanged JSON codec; not old Host/Worker binaries'},
        'legalDeclarationsRemainBlocked': {'status': 'PASS', 'handlerCalls': 0},
        'original63CasesAndR1Assertions': {'status': 'PASS', 'filesUnchanged': integrity['originalTestFilesUnchanged'],
            'evidence': 'Unchanged original Core 39, SDK 14, native Worker 10 test files executed in full regressions; Core + Worker also in stability rounds'},
        'c1MalformedSchemaNativeWorkerE2E': 'NOT_TESTED',
    },
    'performance': 'NOT_TESTED', 'coverage': 'NOT_TESTED', 'fullHistoricalBinaryCompatibilityMatrix': 'NOT_TESTED',
    'limitations': ['Core change is not a general JSON Schema validator.',
        'Actual Ref resolution/effectiveArgs/provenance/new execution IPC remain NOT_IMPLEMENTED and NO-GO.',
        'receivedArgs expanded payload echo remains a separate pre-execution Gate.',
        'Ignored build outputs/caches excluded from source worktree inventory; test process wall times are not performance measurements.'],
    'goNoGo': 'C1_FIX_DELIVERED_PENDING_CHATGPT_REVIEW', 'limitedPassGranted': False,
    'blockers': [{'code': 'INDEPENDENT_REVIEW_PENDING', 'scope': 'Wave 2C LIMITED PASS'}],
}
(directory / 'GATE_STATUS.json').write_text(json.dumps(gate, indent=2, ensure_ascii=False) + '\n')

rows = '\n'.join('| ' + str(i) + ' | `' + shlex.join(record['command']) + '` | ' + str(record['exitCode']) +
    ' | ' + (json.dumps(record['stats']) if record['stats'] else '类型检查，无测试计数') + ' |' for i, record in enumerate(final, 1))
(directory / 'VALIDATION_RESULTS.md').write_text(f'''# Wave 2C C1 验证记录

所有结果来自本目录 `commands.jsonl` 和 `test-*.log`。没有用上一批运行数字替代本轮运行。

## 红绿证据

- 修改生产源码前先新增独立 C1 文件：26 cases，17 passed /9 failed，exit 1。四个漏拒场景各执行一次合成 Handler；两个属性依赖误拒及三个同名 Schema/boolean dependency 对照失败。
- 本轮先以 Runtime tsc 构建起点代码，再原样执行独立 v3 脚本：10 cases /6 violations，exit 1。保留原脚本及其原结果文件，stdout/stderr 另存本目录。
- 最小修复后，新 C1 26 +原 Core 39：2 files /65 passed，exit 0。没有编辑旧测试期望或增加 skip/todo。
- 六项全量回归后再执行同一个独立 v3：10 cases /0 violations，exit 0；ordinary/default/const/enum/examples 五个错误位置均在注册及 V2 校验阶段返回 REF_DECLARATION_INVALID，Handler=0。
- 原样执行起始 Registry 对照脚本：dependencies、dependentRequired 两种普通 Schema 在 Wave 2C 起点和当前版本均接受，四次合成 Handler 各执行一次，均 success:true，exit 0。范围仅 Registry 模块内存转译，复用当前未变 JSON codec，不代表历史 Host/Worker 二进制矩阵。

## 最后一次生产编辑后的六项顺序回归

生产文件 mtime：`{modified.isoformat()}`。第一项开始于 `{final[0]['startedUTC']}`。命令逐项等待退出后才启动下一项。

| 顺序 | 实际命令 | Exit | 实际计数 |
| --- | --- | --- | --- |
{rows}

Runtime 总计 733 cases，其中 723 passed /3 skipped /7 todo；后两类为原有用例，本批未新增。SDK 110 passed；IDE 27 passed。

## 稳定性及 R1

三轮均为 13 files /200 passed /0 failed /0 skipped /0 todo，均 exit 0。包括新 C1、原 Wave 2C/Core source-binding、Ref 合同、真实 SDK/Worker、R1、lifecycle、readonly、versioned-file 和 producer-race。
原始 R1 真实 Worker：0/4 违规；受控 transport：0/10 违规，均 exit 0。具体 argv、时间、完整输出见 `test-c1-*.log`。

## 证明层次与未测范围

新增 26 个测试和独立 v3 使用真实 Core 函数、V2 validator、Registry 和合成 Handler，不是本批异常 Schema 的 SDK/Worker 全链路。既有 Wave 2C 的 SDK 14 /真实 Worker 10 /Core 39 个用例及原 R1 29 个用例文件保持起点指纹，并实际纳入回归；不能将这些既有路径当成 C1 异常变体的 Worker E2E。
本批异常 Schema 的真实 Worker E2E、性能、coverage、完整历史二进制兼容矩阵：NOT_TESTED。进程 wall time 只是命令运行耗时，不是产品 SLA。
Ref 值解析、effectiveArgs/provenance 授权、新执行 IPC：NOT_IMPLEMENTED /NO-GO。未改变默认路由、开关或 Strict 状态。
''')

(directory / 'CODEX_C1_RESULTS.md').write_text(f'''# Wave 2C C1 限定修复交付

结论：C1 反例已修复并完成本轮回归，建议交由 ChatGPT 复验；**未自行授予 Wave 2C LIMITED PASS**。

## 根因与最小差异

起点 `ref-declarations.ts` 的 `visit()` 只识别部分 Schema 成员映射。遗漏旧 `dependencies` 后，整个映射被当成 Schema 对象：映射名 default/const/enum/examples 被错误跳过；映射名 x-aotui-ref 被错误当作声明。dependentRequired 的实例属性名也被按 Schema 对象解释。因此同一根因造成漏拒和误拒，而非 Ref 值展开或 caller 获得任意 Schema 写权限。

本轮只改一个生产文件 `runtime/src/core/tool/ref-declarations.ts`（5 行增加、3 行移除，含注释）：

1. 复用原有 Schema map 分支，增加 dependencies；成员名只用于定位路径，不参与 Schema 关键字解释。Schema 成员继续递归，错误位置声明仍报 REF_DECLARATION_INVALID。
2. dependencies 的数组成员是属性依赖数据，明确跳过，避免将其当作 Schema。
3. dependentRequired 是属性名到依赖列表的映射，不把该映射当作 Schema。default/const/enum/examples 的真实字面数据继续保持不透明。

没有引入通用 JSON Schema 引擎；未改变声明位置、metadata exact-shape、预算、canonical/binding 或既有错误码。合法顶层声明继续保留到 Schema/V2，但执行返回 REF_CONTRACT_UNSUPPORTED，Handler=0。

新增 `runtime/src/core/tool/ref-declarations.wave2c-c1.test.ts`，共 26 cases：完整重现本次四个漏拒、两个兼容性反例，并对 Schema-valued/boolean dependencies、已有五类 Schema map、四种真实字面数据、保留字参数名及合法声明继续拒绝执行作对照。

## 红绿轨迹和兼容性

修改前新测试 9 failed /17 passed，独立 v3 为 6/10 违规；修改后 26 个新用例和 39 个原 Core 用例全绿，未修改的独立 v3 为 0/10。原样起点 Registry 对照恢复两种普通依赖 Schema 的接受与 Handler success:true 行为。该对照使用已保存起点模块和当前未改 JSON codec，未夸大为旧 Host/Worker 的完整二进制验证。

六项顺序回归：Runtime 74 files /723 passed /3 skipped /7 todo，SDK 11 files /110 passed，IDE 6 suites /27 passed，三处 tsc 成功。三轮定向各 13 files /200 passed；原始 R1 为真实 Worker 0/4、受控 0/10 违规。完整命令、退出码、证据层次见 VALIDATION_RESULTS.md 与 GATE_STATUS.json。

原 Wave 2C 的三份测试文件（39+14+10=63 cases）与 R1 29-case 文件内容均未变，并实际运行。Core/SDK/IDE 其它生产源码、Host、Worker IPC、SDK API、默认 Router、实验开关和 Strict 标志均保持本轮起点内容。

## 用户工作树及原证据保护

- HEAD：`{baseline['head']}`；暂存差异输出 SHA-256 前后同为 `{integrity['finalIndexSha256']}`。
- 另行核验 `.git/index` 文件本体 SHA-256 前后相同，值为 `{integrity['finalIndexFileSha256']}`。没有把两种哈希混同。
- 起点清单为 1368 条路径记录：1346 个存在文件、22 个缺失路径。除计划内一个 Core 文件精确修改外，其余 1367 条内容或缺失状态不变，所有 586 条既有 RFC 路径均保持。没有越界新增路径；新增源码仅 C1 测试，其余新增都在本批独立证据目录。
- 原 helper 起点已是 untracked，不能靠 git diff 证明它没变；起点完整备份、1368 条指纹和本轮增量 patch 共同保护已有内容。未暂存 diff 输出恰好也保持 `{integrity['finalUnstagedDiffSha256']}`，并不代表 untracked 源码无变化。
- inventory 在创建本证据目录之前采集；`baseline-status.porcelain-v1.txt` 是持久化备份后真实执行的原始 status，含当时已写入的本目录自身条目。保护判断以预先采集的 baseline.json 为准。忽略规则覆盖的构建产物/缓存不在源文件清单内。
- `incremental-changes.patch` 相对本轮起始工作树，只包含一个生产差异和一个新测试；在 mkdtemp 起点副本中 `git apply --check` exit 0，未对用户 index 或工作树应用该检查。

## 剩余限制与停点

本批新增反例是 Core/Registry/V2 +合成 Handler 证据；C1 异常 Schema 的真实 SDK/Worker 全链路为 NOT_TESTED。已有真实 Worker 声明阻断路径与 R1 保持回归支持。校验器仍不是通用 JSON Schema 规范验证器，也不是恶意 JavaScript 沙箱。
性能、coverage、完整历史二进制矩阵均 NOT_TESTED。没有执行 Ref 解析、effectiveArgs/provenance、新执行 IPC 或未来 receivedArgs 展开结果处理；receivedArgs 回显作为真正 Ref 执行前的独立必验项保留。

本轮止于 C1 再验收，不实现后续 API，不切换路由，不开放写入，不改变 Strict，不自动执行后续批次。
''')

(directory / 'NEXT_REVIEW_RECOMMENDATION.md').write_text('''# 下一步仅为 C1 独立复验

建议 ChatGPT 先审查仅含一个生产文件和一个新测试的 incremental-changes.patch，再原样运行独立 v3 和普通 Schema 起点对照脚本，核对四个非法依赖成员 Handler=0、两个普通依赖保留兼容、合法顶层声明继续拒绝执行。

按最后源码状态复验六项回归、三轮定向及原始两个 R1 脚本，并重新核对 baseline.json /integrity-final.json /source-fingerprints.json。原 Wave 2C 63 个用例和 R1 29-case 文件应继续保留。由负责人决定是否签署 Wave 2C LIMITED PASS。

此步骤不授权任何 Ref 执行。通过后若另行批准实际 Ref 执行切片，仍需独立设计并验证 effectiveArgs/provenance、预算、执行 IPC 和 receivedArgs 回显合同；本轮不实现或启动它们。
''')

artifacts = {}
for path in sorted(directory.rglob('*')):
    if path.is_file() and path.name not in ['source-fingerprints.json', 'PACKET_SEAL.json']:
        data = path.read_bytes()
        artifacts[str(path.relative_to(directory))] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
manifest = {'stage': 'Wave 2C C1', 'head': baseline['head'], 'sources': sources,
    'artifactRoot': str(directory.relative_to(root)), 'artifacts': artifacts,
    'exclusions': ['source-fingerprints.json (self)', 'PACKET_SEAL.json (independent final verifier output)'],
    'patchScope': 'Relative to this batch starting worktree; source/test only, not prior Wave 2C changes or evidence files'}
(directory / 'source-fingerprints.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'goNoGo': gate['goNoGo'], 'rawCommandLogs': len(commands), 'artifactCount': len(artifacts),
    'sources': sources, 'finalRegressionStats': [record['stats'] for record in final],
    'stabilityStats': [record['stats'] for record in stability], 'originalR1': r1}, indent=2))
