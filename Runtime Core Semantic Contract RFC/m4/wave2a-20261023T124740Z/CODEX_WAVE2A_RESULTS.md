# Wave 2A — 限定交付完成，等待 ChatGPT 验收

只修改现有只读入口，复用 Core/Registry/Worker IPC/SDK Hook；没有启动代理或执行后续批次。不宣布完整 M4/Strict PASS，不切换默认 Agent Router，不开放可写 Tool。

## 基线与改动范围

- 实际 Node v24.15.0 / pnpm 10.15.1，未安装依赖或改变全局配置。
- HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`。
- staged diff SHA-256：`258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`，本批前后必须一致。
- worker-host.ts 起始 SHA-256：`3326f6b0f84caae9d189e8856dcc71a1ed16cea61784df0bd140572820b3087e`，与批准值一致。
- 当前基线记录 154 条 Git 状态、1145 个 tracked/非忽略路径；只读备份见 baseline.json、baseline-status.log、baseline-readonly/。忽略的编译产物不在该清单内。

| 文件 | 本批影响 |
| --- | --- |
| runtime/src/engine/app/worker-host.ts | 唯一生产修改，全部位于 executeReadOnlyViewTool 内：完整输入固定、原预算复核、固定来源再检查、字面 true 授权、冻结 scope、异常边界 |
| runtime/src/engine/app/worker-host.wave2a-request.test.ts | 新增 20 个 Host + 真实 Core Store 输入/来源/授权/预算测试；其模拟 dispatch 不冒充真实 Handler 证据 |
| runtime/src/core/tool/source-binding.wave2a.test.ts | 新增 2 个纯 Core clock/lease/历史保留合同测试；Core 实现不改 |
| runtime/src/engine/app/worker-host.wave2a-readonly.test.ts | 新增 16 个真实 SDK + Worker 双 View、Handler/注册/来源/结果/生命周期用例 |

没有修改既有测试、Core/SDK/IDE/Worker 的生产源码、Snapshot V1/V2 Schema、公开 IPC、默认路由、实验默认值或 Strict 标志。源文件指纹和相对**本次起始工作树**的 patch 在本目录。上批 Codex 包和 ChatGPT 独立审计目录保持原内容。

## 发现与证据分级

| 项目 | 已确认的事实 | 没有据此声称的结论 |
| --- | --- | --- |
| caller selector 被再次读取 | 授权后会检查替换后的来源；真实 SDK 测试观察到本应复核 A 的请求转去核查另一有效 Tool | 仅此差异不证明实际 Handler 已越权串到 B；实际执行仍使用原选择 |
| 历史 TTL 来源可被替换洗白 | Core pin 保留条目但新 acquire 已应失败；caller 换成新 Snapshot 后，原实现实际执行了 A Handler 一次 | 这是来源有效性合同被绕过，不等于证明某个业务角色权限被绕过或默认 Agent 已可利用 |
| truthy 授权 | Host 反例中 1 / 'false' / {} 会进入模拟 dispatch；null/undefined 原来就拒绝 | Controller 是可信显式回调，不把此测试伪装成公网/OS 攻击证明 |
| getter / 非法根请求 | 请求 getter 被执行；null 根导致 API Promise 抛异常；未统一严格处理整个请求 | 不把 Proxy 反射校验当沙箱 |
| 任意异常值 | 初始来源异常逃出 API；策略/dispatch 异常 message getter 会在 Host 错误处理再次抛异常 | source 异常 getter 也可能由失败测试的错误格式化读取，不能都归因于 Host 主动读 message |
| Core/Worker 当前绑定防护 | 同名 View 重挂载、Tool 版本/Schema/禁用、Worker 活态检查等新测试在修复前已通过 | 没有重复实现正确机制，也没有因此宣布 Strict |

真实 Worker 的原始反例输出：

```text
WAVE2A_TTL_RECHECK={"success":true,"calls":{"A":1,"B":0,"query":0}}
```

修复后及最终三轮均输出：

```text
WAVE2A_TTL_RECHECK={"success":false,"code":"SNAPSHOT_EXPIRED","calls":{"A":0,"B":0,"query":0}}
```

测试仅使用 mkdtemp 应用/Worker fixture，没有操作用户业务文件。真实测试用现有 Core factory 的 now/options，在 INIT 前配置测试 Core；这不是生产第二 Store。Worker live 防护的故障注入只在测试中丢弃后续 PREPARED，保留真实 SDK 注册与真实 IPC，让 Worker 独立拒绝旧绑定。

## 最小修复与兼容性

复用 copyJson 对外部完整请求复制一次；只执行首次副本。随后在冻结 args 副本上用同一 codec 复核原 maxDepth 24 / maxNodes 10000 / 128 KiB 预算，不再次读取 caller。完整外层额度增加的是容纳对象和三个 selector 的空间，不放宽 args；精确 UTF-8、节点和深度边界均验证。

固定 sourceRequest 在授权前后复用；授权 scope 冻结且只有 true 放行。初始来源 throw 和策略/派发异常转为固定 VIEW_TOOL_DISPATCH_FAILED，不检查任意异常对象的 message。业务 OperationResult、SDK 验证和 Worker route 未变。

有意收紧的行为：根请求必须严格四字段、selector 必须非空字符串；controller 返回 truthy 非 boolean 不再授权；scope 不可改写；某些非法输入现在先返回 OPERATION_INVALID_ARGS，而不是在来源选择阶段返回缺失/过期。异常的 message 文本不再透传，但现有错误 code 保持所属类别。请求总大小现在有明确 136 KiB 上限。

原 args 可接受边界没有变。第二次 codec 检查会做一次额外的有界遍历/临时分配，用于保留原预算；没有为此扩展 codec 或新建验证框架。性能成本未作专门测量，不将它写成零成本。

完整支持/不支持语义、TTL 和 Ref 边界见 CONTRACT.md。特别是通用 Ref 自动解析、任意闭包状态冻结、跨 Worker 原子截止时间、恶意 Handler 沙箱不在本合同中。

## 本次真实红绿轨迹

| 日志 | 实际结果 |
| --- | --- |
| test-red-request-and-core.log | 14 failed / 8 passed；包含修复前已正确的 2 个纯 Core 用例 |
| test-red-real-sdk-worker.log | 3 failed / 13 passed；其中一个是新 fixture 对 fresh A 发布的等待条件过弱 |
| test-red-real-sdk-worker-confirmed.log | 将“可能 undefined 也通过”的等待加强为 View 存在且 Tool target 匹配，保持原安全断言后：2 failed / 14 passed；两个来源反例保留 |
| test-green-wave2a-first.log | 3 files / 38 passed，exit 0；未改 Core/Worker/SDK 实现 |

fixture 同步修正没有提高 timeout 或改变预期；使用明确状态/事件和 Promise gate，没有 sleep。全部失败日志保留，不增加 skip/todo。新增用例中拒绝路径通过 Handler 计数或没有 VIEW_TOOL_INVOKE 消息证明没有用户 Handler 执行；业务 success:false 路径则明确允许 Handler 已执行。

## 最终回归和稳定性

六条命令按任务书顺序实际执行，原始 stdout/stderr 和退出码见 test-final-wave2a-*.log：

| 命令 | 结果 |
| --- | --- |
| pnpm --dir runtime exec tsc --pretty false | exit 0，构建当前 Runtime |
| pnpm --dir sdk exec tsc --noEmit --pretty false | exit 0 |
| pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false | exit 0 |
| pnpm --dir runtime exec vitest run --reporter=dot | exit 0，70 files / 631 passed / 3 skipped / 7 todo |
| pnpm --dir sdk exec vitest run --reporter=dot | exit 0，9 files / 86 passed |
| pnpm --dir demo-apps/aotui-ide exec jest --runInBand | exit 0，6 suites / 27 passed |

R1 原始两个未修改脚本本次重跑：真实 Worker 0/4、受控 transport 0/10，均 exit 0。R1 的 29 个正式回归全部保留，进入全量与三轮定向复跑。

三轮每轮 **9 files / 108 passed / 0 skipped/todo / exit 0**。确切文件为三个新 Wave 2A 文件、R1、原 lifecycle、原 source-binding、原 readonly、producer-race、versioned-file；完整参数在 commands.jsonl 和 GATE_STATUS.json。这里没有引用旧日志作为本次结果。

NOT_TESTED：专门的性能/CPU/heap/内存预算对比、coverage 百分比、IDE/LSP 产品工作负载和 SLA。既有 readonly 测试仍打印微型 round-trip diagnostic，不能当成本批性能门槛或产品 SLA。

## 保护核验与停止位置

本批未执行 git add/commit/reset/restore/clean/stash/checkout/push/rebase。最终 index 指纹、HEAD、旧审计目录及全部基线文件的保护检查见 test-integrity-wave2a.log、final-integrity.json、source-fingerprints.json。只有 worker-host.ts 是既有路径的预期修改，其余新文件均在声明范围内。

旧交付包原样保留，其指纹描述历史交付状态；当前源码以本 Wave 2A 增量清单为准，不去改写旧审计结论或结果文件。

**仅建议：Wave 2A 限定交付完成，等待 ChatGPT 验收。** 之后停止；不进入可写 Tool、后续批次、完整 M4 或 Strict 准出。
