# ChatGPT 独立复验：Stage 8 R1 关闭，Stage 8 limited PASS

复验日期：2026-10-23。验收对象：`codex-r1-20261023T121303Z`，以及上一轮 Stage 8 的限定交付范围。验收负责人：ChatGPT。

## 1. 正式结论

| 项目 | 独立决定 |
| --- | --- |
| R1：已失效生命周期 continuation 恢复错误 Host 状态 | **CLOSED** |
| M4 Stage 8 / Wave 1 限定范围 | **LIMITED PASS** |
| 完整 M4 / Strict Snapshot Producer | **NO-GO** |
| 默认 Agent V2 可写路由 | **NO-GO** |
| Wave 2 实施 | 本次未执行；下一批仅允许用户转发的 Wave 2A 限定任务 |

这份结论替代上一轮对 Stage 8 的 `REQUEST_CHANGES`，但不改写或删除原失败日志。通过意味着已经处理本批约定的缺陷与验收要求，不代表所有 Runtime、SDK、IDE 和文件系统边界均已完成生产验证。

## 2. 源码审查：修复确实是最小的 8 行

生产文件 `runtime/src/engine/app/worker-host.ts` 相对本次只读基线新增 8 行，删除 0 行。新增测试文件 `worker-host.r1-terminal-race.test.ts` 共 29 个用例；既有测试没有被更改。

关键位置为当前源码第 109、853–875、1010–1015 行：

- 发出生命周期请求时捕获当前 Worker 对象及私有 `lifecycleContextVersion`。
- transport Promise 完成后，先确认 Worker 所有权及内部执行上下文仍相同，再执行原有的 closing/closePromise/releasePromise 检查，最后才更新 Host 状态。
- INIT 与 error 推进私有上下文版本。它解决“物理 Worker 对象没变，但旧请求已经失效”的情况。
- terminate/exit 清除或更换 Worker 时，Worker 所有权比较拒绝旧 continuation。

这个私有版本号**不是** View generation、AppInstanceId、Snapshot revision，也不是新的公开身份或权限凭据。不需要将其推广成通用框架原语。

为何不能只判断 `status === closed/error`：同一个 Worker 可以发生新的合法 INIT；error 也可能发生在已经为 error 的状态。仅比较状态值会遗漏“状态相同、上下文已经变过”的情况。捕获所有权与内部失效版本，既阻止旧响应污染新执行，也保留合法恢复能力。

没有增加依赖、第二份 Store、生命周期框架、公开 IPC 字段或默认路由开关。

## 3. 独立重新执行的证据

本次明确选择 Node **v24.15.0** / pnpm **10.15.1**。设备默认 shell 的 `node` 仍可能指向 v23.11.0，因此仅在本次测试进程 PATH 前置已安装的 Node 24；没有更改用户全局配置。

先按顺序独立执行六条全量命令，再直接运行上一轮未修改的两个反例脚本，最后执行三轮定向测试。**11 次命令的真实退出码全部为 0**。

| 检查 | 本次独立结果 |
| --- | --- |
| Runtime tsc emit | exit 0 |
| SDK tsc noEmit | exit 0 |
| IDE tsc noEmit | exit 0 |
| Runtime Vitest | **67 files，593 passed / 3 skipped / 7 todo** |
| SDK Vitest | **9 files，86 passed** |
| IDE Jest | **6 suites，27 passed** |
| 原真实 Worker 反例 | **REAL_WORKER_VIOLATIONS=0/4**，exit 0 |
| 原受控 transport 反例 | **VIOLATIONS=0/10**，exit 0 |
| 三轮定向稳定性 | 每轮 **6 files / 58 passed**，全部 exit 0 |

旧反例脚本没有被改写。原真实 Worker 4/4、受控 transport 10/10 的失败记录仍保留；本次结果另写独立目录，没有用覆盖旧日志的方式使失败“消失”。

新增测试的分层证据准确：真实 Worker ACK fixture 验证 Host 与 node:worker_threads 消息顺序，不冒称完整 SDK 应用；现有 versioned-file、readonly、producer-race、snapshot-shadow 联合测试继续覆盖真实 SDK/Worker 路径。合法 close/reopen 的 transport 测试也不代表允许复活已经 stopped 的 Shadow Store。

## 4. 工作树与证据完整性

```
HEAD:
789ef07cb18084d97b0476c1ffc234ae0b9319f0

staged diff SHA-256:
258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54

当前 worker-host.ts SHA-256:
3326f6b0f84caae9d189e8856dcc71a1ed16cea61784df0bd140572820b3087e
```

独立核验 R1 的 1096 个基线路径、2 个源码／测试文件、30 个附件及 17 份运行日志指纹。已有路径只有声明的 `worker-host.ts` 发生变化；原独立审计目录的 18 个文件均保持一致。基线中已经不存在的 22 个路径仍按“原先不存在”处理，没有误报为新增删除。

复验开始与结束之间比较 1128 个既有 tracked/非忽略路径：**0 个内容变化**。本次仅在新独立审计目录写入日志、JSON 和评审材料；TypeScript 编译产生的既有忽略产物不计作源码变更。未启动 Codex 或其他代理，未执行 Git add/commit/reset/restore/clean/stash/checkout/push/rebase。

## 5. 仍然存在的边界

R1 只保证旧生命周期 continuation 不再冒充当前有效执行，不表示 Worker 回调或磁盘副作用从未发生。没有新增回滚、取消、自动重试或跨重启 exactly-once。

Stage 8 原有未准出项继续保留：Strict CommitBarrier、默认 Agent mutating 路由、不合作外部文件写入者、内容哈希 ABA、文件元数据保留、持久化幂等性、真实 IDE/LSP 工作负载、第二个独立 Host Adapter、规模和性能预算。没有将历史未测试项改成 PASS。

下一批应处理现有通用只读 Tool 来源执行链的完整请求、授权与 Handler 契约，不继续扩大专用文件替换 API。对只读入口的初步静态复核发现：其授权仍采用 truthy 判断、授权后重读调用方请求字段，且错误边界与新写入入口不一致。这些属于下一批应先用反例检验的既有差异，**本次没有声称已修复或已经形成完整安全证明**。

## 6. 仓库内完整证据

```
Runtime Core Semantic Contract RFC/m4/stage8/
└── independent-r1-review-20261023-01/
    ├── CHATGPT_STAGE8_R1_ACCEPTANCE.md
    ├── INDEPENDENT_R1_GATE.json
    ├── integrity-before.json
    ├── integrity-after.json
    ├── review-start-file-hashes.json
    ├── independent-reruns.json
    ├── runtime-tsc.log / sdk-tsc.log / ide-tsc.log
    ├── runtime-vitest.log / sdk-vitest.log / ide-jest.log
    ├── original-real-worker-repro.log
    ├── original-controlled-repro.log
    └── stability-1.log / stability-2.log / stability-3.log
```

**验收签署：R1 CLOSED；Stage 8 LIMITED PASS。完整 M4 / Strict / 默认可写路由仍 NO-GO。**
