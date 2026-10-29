# Wave 2A 独立验收：LIMITED PASS

日期：2026-10-23。验收人：ChatGPT。执行者：用户转发任务的 Codex。

**结论：接受 Wave 2A 的限定交付。Stage 8 R1 保持 CLOSED；完整 M4、Strict、默认 Agent 路由切换及可写 Tool 开放仍不批准。**

本次没有启动 Codex、没有修改生产源码或既有测试，没有执行 Git 写操作。仅在独立审计目录新增检查记录与临时测试脚本；测试编译产生的 ignored 构建产物不属于生产源代码改动。

## 1. 交付范围核验

仓库：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`。

Codex 交付目录：`Runtime Core Semantic Contract RFC/m4/wave2a-20261023T124740Z/`。

本次独立审计目录：`Runtime Core Semantic Contract RFC/m4/independent-wave2a-review-20261023-01/`。

已实际核验：

- 4 个源码／测试文件的最终 SHA-256；生产修改只有 `runtime/src/engine/app/worker-host.ts`。
- 生产增量为新增 39 行、删除 29 行，全部位于 `executeReadOnlyViewTool`。方法之外的代码与本批起始备份完全一致。
- 新增 3 个测试文件、38 个用例；既有 Core／SDK／Worker 生产代码、IPC、默认 Agent 路由、可写入口、Strict 标志未修改。
- 35 个验收附件、16 份命令运行日志的内容指纹与记录一致。
- 原 Stage 8／R1 的 144 个受保护证据文件保持原内容。
- Codex 的 1145 个起始路径中，唯一发生内容变化的既有路径是上述生产文件；其中 22 个路径在起始清单中已经不存在，不属于本批删除。

审核期间，另对本次开始时的 1184 个 tracked／非忽略路径保存并重查指纹，内容变化为 0。新审计记录只写入独立审计目录。

## 2. 本批修复为什么成立

### 2.1 一次调用固定一次完整请求

旧代码授权前读取外部请求，授权等待后再次读取相同 caller 对象。它可能重新核查另一个有效 Snapshot／目标，但执行最初选中的 Tool。

现入口在来源选择、授权或 Worker await 前使用现有 `copyJson` 固定完整请求。后续来源选择、授权、再次租用和派发只使用这份副本。授权 scope 及 args 冻结；普通 getter、非 JSON、非法字段与超限值在前置阶段拒绝。

这保证的是一次调用的 JSON 值和来源选择固定，不是冻结 SDK Handler 的闭包或业务状态，也不是阻止 Proxy trap 的 JavaScript 沙箱。

### 2.2 权限只接受明确的 true

Controller 必须明确返回布尔值 `true`。数字、字符串和对象不再因为 truthy 而得到放行。Snapshot 可用、View 身份匹配和 `isMutating:false` 均不能取代 Controller 的业务授权。

### 2.3 过期历史快照不能被替换的新选择器“洗白”

保留在 Store 中的历史数据不等于仍可重新 acquire 为执行来源。授权后复核现在使用原始 `sourceRequest`，而不是 caller 修改后的选择器。旧来源到期时，调用拒绝且没有目标 Handler 执行。

### 2.4 异常处理不会再读取任意 throw 对象的 message

初次来源选择和授权／派发异常均落入固定失败类别。Host 不再通过异常对象的 `message` getter 触发第二次异常。该性质限定为本批 Host 方法，不扩展为可信 SDK Handler 的恶意代码隔离保证。

### 2.5 没有重复实现已经正确的机制

现有 Core／Worker 的 ViewInstance、bindingVersion、Tool Schema、启用状态检查及 SDK 参数验证继续复用。没有引入第二个 Store、第二套执行器、公开身份或新的 IPC。

原 args 预算仍为深度 24、节点数 10000、近似 128 KiB。完整请求新增深度 25、节点数 10004、近似 136 KiB 上限。在冻结副本上再检查 args 预算有一次有界遍历和临时分配，不能声称零成本；专门性能 Gate 本轮未执行。

## 3. 独立重跑的实际结果

环境：已安装的 **Node v24.15.0／pnpm 10.15.1**。仅调整本次命令环境 PATH，没有更改系统全局配置或安装依赖。

| 独立执行 | 实际结果 |
| --- | --- |
| Runtime TypeScript build | exit 0 |
| SDK TypeScript noEmit | exit 0 |
| IDE TypeScript noEmit | exit 0 |
| Runtime 全量 Vitest | 70 files，631 passed／3 skipped／7 todo |
| SDK 全量 Vitest | 9 files，86 passed |
| IDE 全量 Jest | 6 suites，27 passed |
| R1 原真实 Worker 反例 | 0/4 违规，exit 0 |
| R1 原受控 transport 反例 | 0/10 违规，exit 0 |
| 三轮定向稳定性 | 每轮 9 files／108 passed，无 skip/todo，均 exit 0 |

上述 11 次命令均由本次独立验收实际执行，记录在 `independent-reruns.json` 和对应日志中，不是引用 Codex 的通过结论。

## 4. 新增独立、真实 SDK／Worker 的修复前后对照

除了重跑交付测试，我另写了 `ttl-source-differential.mjs`：从只读基线加载修复前 Host，并与当前 Host 分别在独立临时目录构建，使用相同真实 SDK、Worker 和 Core 合同。没有替换或回退工作树内的生产代码。

受控时序：A 来源已取得 lease；授权等待期间产生新 Snapshot；caller 改成新来源与 B；推进测试时钟，使旧来源仍因 pin 可读取，却已不能重新租用。

| Host 版本 | 实际返回 | A Handler 次数 | B Handler 次数 |
| --- | --- | --- | --- |
| 修复前的只读基线 | success:true，返回 A | 1 | 0 |
| 当前实现 | success:false，SNAPSHOT_EXPIRED | 0 | 0 |

两种情况结束后 activeLeases 均为 0。差分脚本整体 exit 0，表示“复现旧失败、确认新合同”的断言全部成立。它是本次第 12 次独立执行命令。

证据：`ttl-source-differential.mjs`、`ttl-source-differential.log`、`differential-review.json`。

**结论限定为来源有效性／TTL 合同被修复。没有因此声称原实现发生了业务角色权限越权、执行了 B Handler，或默认 Agent 已能够利用该问题。**

## 5. Git 与源码保护

```text
HEAD:
789ef07cb18084d97b0476c1ffc234ae0b9319f0

staged diff SHA-256:
258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54

本次接受的 worker-host.ts SHA-256:
28ede7ca387b143e45cbb9df2da8c779ac9a82d5a22f75931d298a2cdfbbfeee
```

初次和最终检查一致。旧审计目录、原失败日志和 R1 独立反例保持原内容。详细核验见 `integrity-before.json`、`integrity-after.json`、`review-start-file-hashes.json`、`INDEPENDENT_WAVE2A_GATE.json`。

## 6. 不属于本次批准的事项

1. 通用 Ref 参数自动解引用尚未支持。reference 形状的字符串／对象仍只是 caller JSON，不是 Runtime 已解析、已授权的实体。
2. 来源再租用是 Host 派发前的检查，不是 Worker 队列或 Handler 执行时的原子 deadline；未提供派发后 TTL 取消、回滚或 exactly-once。
3. 同一 SDK 稳定注册的 Handler 可能读取最新闭包；本次不冻结任意业务数据。
4. `isMutating:false` 是可信开发者声明，不是 OS 沙箱。默认 Agent 路由和可写能力未开放。
5. Strict CaptureBarrier、第二个正式 Adapter、真实 IDE／LSP 规模负载、CPU／heap／p50／p95 和专项覆盖率百分比未完成。
6. 本批公开兼容收紧应保留记录：根请求严格四字段、总请求限额、字面 true 授权、固定异常信息；不要描述为完全无行为变化。

没有发现阻塞 **Wave 2A 已声明合同** 的问题。以上边界不得被后续报告省略。

## 7. 下一步方向

建议下一批先提交 **Wave 2B：只读 Ref 参数来源合同的设计 Gate**，解释如何从已租用来源 Snapshot 解析准确的 Ref，而不是猜测字符串或查最新索引。先确定声明、授权、旧值／新值与跨 View 规则，验证现有 Store 行为；涉及 Schema／公开 API／IPC 的变更须另行审查。

不在此验收中授权新实现、默认路由切换或 Strict 开启。下一份 Prompt 由用户手动转发，Codex 完成限定交付后停止，再交 ChatGPT 独立验收。

**最终签署：Wave 2A LIMITED PASS；Stage 8 R1 保持 CLOSED；完整 M4／Strict／默认 Agent 可写开放 NO-GO。**
