# Wave 2C C1 验证记录

所有结果来自本目录 `commands.jsonl` 和 `test-*.log`。没有用上一批运行数字替代本轮运行。

## 红绿证据

- 修改生产源码前先新增独立 C1 文件：26 cases，17 passed /9 failed，exit 1。四个漏拒场景各执行一次合成 Handler；两个属性依赖误拒及三个同名 Schema/boolean dependency 对照失败。
- 本轮先以 Runtime tsc 构建起点代码，再原样执行独立 v3 脚本：10 cases /6 violations，exit 1。保留原脚本及其原结果文件，stdout/stderr 另存本目录。
- 最小修复后，新 C1 26 +原 Core 39：2 files /65 passed，exit 0。没有编辑旧测试期望或增加 skip/todo。
- 六项全量回归后再执行同一个独立 v3：10 cases /0 violations，exit 0；ordinary/default/const/enum/examples 五个错误位置均在注册及 V2 校验阶段返回 REF_DECLARATION_INVALID，Handler=0。
- 原样执行起始 Registry 对照脚本：dependencies、dependentRequired 两种普通 Schema 在 Wave 2C 起点和当前版本均接受，四次合成 Handler 各执行一次，均 success:true，exit 0。范围仅 Registry 模块内存转译，复用当前未变 JSON codec，不代表历史 Host/Worker 二进制矩阵。

## 最后一次生产编辑后的六项顺序回归

生产文件 mtime：`2026-10-24T03:40:03.596469+00:00`。第一项开始于 `2026-10-24T03:41:38.102180+00:00`。命令逐项等待退出后才启动下一项。

| 顺序 | 实际命令 | Exit | 实际计数 |
| --- | --- | --- | --- |
| 1 | `pnpm --dir runtime exec tsc --pretty false` | 0 | 类型检查，无测试计数 |
| 2 | `pnpm --dir sdk exec tsc --noEmit --pretty false` | 0 | 类型检查，无测试计数 |
| 3 | `pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false` | 0 | 类型检查，无测试计数 |
| 4 | `pnpm --dir runtime exec vitest run --reporter=dot` | 0 | {"filesPassed": 74, "filesFailed": 0, "passed": 723, "failed": 0, "skipped": 3, "todo": 7} |
| 5 | `pnpm --dir sdk exec vitest run --reporter=dot` | 0 | {"filesPassed": 11, "filesFailed": 0, "passed": 110, "failed": 0, "skipped": 0, "todo": 0} |
| 6 | `pnpm --dir demo-apps/aotui-ide exec jest --runInBand` | 0 | {"suitesPassed": 6, "passed": 27, "failed": 0, "skipped": 0, "todo": 0} |

Runtime 总计 733 cases，其中 723 passed /3 skipped /7 todo；后两类为原有用例，本批未新增。SDK 110 passed；IDE 27 passed。

## 稳定性及 R1

三轮均为 13 files /200 passed /0 failed /0 skipped /0 todo，均 exit 0。包括新 C1、原 Wave 2C/Core source-binding、Ref 合同、真实 SDK/Worker、R1、lifecycle、readonly、versioned-file 和 producer-race。
原始 R1 真实 Worker：0/4 违规；受控 transport：0/10 违规，均 exit 0。具体 argv、时间、完整输出见 `test-c1-*.log`。

## 证明层次与未测范围

新增 26 个测试和独立 v3 使用真实 Core 函数、V2 validator、Registry 和合成 Handler，不是本批异常 Schema 的 SDK/Worker 全链路。既有 Wave 2C 的 SDK 14 /真实 Worker 10 /Core 39 个用例及原 R1 29 个用例文件保持起点指纹，并实际纳入回归；不能将这些既有路径当成 C1 异常变体的 Worker E2E。
本批异常 Schema 的真实 Worker E2E、性能、coverage、完整历史二进制兼容矩阵：NOT_TESTED。进程 wall time 只是命令运行耗时，不是产品 SLA。
Ref 值解析、effectiveArgs/provenance 授权、新执行 IPC：NOT_IMPLEMENTED /NO-GO。未改变默认路由、开关或 Strict 状态。
