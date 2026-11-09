# SRT-04／05 只读准备：独立复核

2026-11-08，Asia/Shanghai。**整体裁决：CHANGES_REQUESTED。** 已核实的现状盘点可以复用；首选方案尚不足以进入生产实施或交项目所有者直接批准。需要补齐 Scope 寿命与累计容量、组合采用的失败边界，并形成具体 API／迁移材料。本结论只评价只读交付，不把尚未实现的方案缺口写成已发生的生产回归。

本轮没有生产修改、没有新增行为测试，没有重跑 TypeScript／LSP，也没有运行 Host、GUI 或真实模型。SRT-04／05 未关闭；共享采用、发布和最终 Semantic 验收均未发生。

## 1. 本次依据

- 原交付：[只读报告](../review-evidence/srt-04-05-readonly-20261108/REPORT.zh-CN.md)，SHA-256 `33e085d047aeba516e78db56c5b0a28b2a1a8222f7030ca70a715f2ae1bd0a7b`。
- 原 [26 项 manifest](../review-evidence/srt-04-05-readonly-20261108/manifest.json)，SHA-256 `456b2305606b7673ed61f57a33b0a86ea41d6dec096403cc03dfebf70ca7ee48`。
- 沿用已完成的 [input-audit.json](../review-evidence/srt-04-05-readonly-20261108/owner-review/input-audit.json)：26 项输入及候选／共享 22 对源码已核对，8 对相同、14 对不同。本轮未重新开展全量盘点。
- [容量和解析入口补充](../review-evidence/srt-04-05-decision-addendum-20261108/CAPACITY_AND_RESOLUTION.zh-CN.md)，SHA-256 `b188f9488544698cc0bc087d794ec47b48a69354f87772ec98b46ee64ffa7077`；其单项 manifest SHA-256 `e83199ffa7c1ae723909952eae783362194a816a7e71ffb4d26985c00605957d`。本轮实际核对了正文哈希和字节数。
- [本轮定向静态复核](../review-evidence/srt-04-05-readonly-20261108/owner-review/followup-static-audit.json)：针对两项主要问题重读六个相关源码，候选、封存共享输入与当前共享身份一致；原报告及 manifest 未改变。

下文源码行号均指技术基线 `.tmp/typescript-sdk-tooling-20261108/candidate-r01`。共享 Source 仍在 Runtime，候选 Source 已在独立 adapter 包；两者不能互相覆盖。HEAD 仍为 `8938449925ada2f92e072e1c0492af8f2428d14f`，不能替代有未提交修改的真实基线。

## 2. 可以保留的现状结论

1. Driver 本轮捕获 Context、组织消息及工具路由，最后释放所捕获的 Context。低层 observe 完成后即取得调用资格；当前没有独立的正式采用步骤。新观察不会自动撤销同 Scope 旧观察。
2. Observation 的释放、实际调用自有 lease 的释放、Snapshot Store 不再持有旧 payload，是三个不同的事实。Store 的 releaseLease 只删除 token，retired 数据可能继续保留到历史 TTL／容量清理。
3. 现行 Ref 注册已拒绝重名，并以 entry 身份约束 update／release，防止旧清理回调删除后继注册。原有历史缺陷不能继续作为当前缺陷，也不需要再造注册体系；本次静态核对不等于新增行为测试通过。
4. Worker 在终态前捕获／发布、Host 按消息顺序接收，有现成基础；单次 `Promise.resolve()` 不构成通用 renderer 提交完成合同。
5. GUI 预览与 CLI 使用独立 Source／Scope；不能让诊断捕获替 Agent 切换正式观察。业务成功、投影提交、捕获、正式采用四个时点需要分开。

## 3. 必须修改的方案部分

### R1：跨轮保留 current 会改变 Scope 与调用记录的寿命

原报告第 3 节建议 Driver 将 current 保留到下一次采用或会话结束。Source 的 `openScope`（213 行）复用每 App Scope，`retireUnownedScopes`（226 行）只在最后 Context owner 消失后关闭它。现行 Driver `run` 的 finally（684 行）每轮释放 Context；在通常没有其他重叠 owner 时，这会结束该轮 Scope。

如果新 current 先建立、旧 current 随后释放，同一 App 的 Scope 就会持续有 owner，可能跨越整个长会话。`scoped-interaction.ts` 的 154–179 行显示：收据 TTL 只清除结果正文；调用条目、请求指纹和元数据要等 Scope 进入 closing、实际 invocation/read/project 均结束后，才在 `clean` 中清除。Observation 换代或 release 不清除这些记录。

其 366–378 行仍按 `entries.size` 限制新调用。默认 `maxReceiptsPerScope=256`；其他字节或总量限制也可能更早触发。假设其他限制允许且使用不同调用 ID，同一未关闭 Scope 已接收 256 个请求后，下一个新请求会因容量被拒绝。`maxInvocationsPerScope=4` 限制的是同时在途调用，不能与累计条目上限混为一谈。默认观察寿命为 scope owner 生命周期，不能用可选 TTL 当作自动解决方案。

**要求：**下一份材料必须比较“Core 显式采用，同时保留 Driver 每轮 finally 释放”与“Driver 跨轮保留 current”。前者仍需说明同 Scope 换代、直接 Core 调用者和诊断的合同，不能退化成只依赖 Driver 清理；后者必须说明新增持有的必要价值、长会话容量与去重期限。产品约束要求新观察采用后旧资格失效，并未直接规定 Driver 必须在已完成回合之间保存可调用 current。不得删防重记录、提高上限、轮换身份或新增账本来悄悄掩盖差异。

### R2：逐个同步采用不能证明多个 App／来源整体失败时旧资格都保留

原报告第 4 节承诺“整体捕获／切换失败保留此前 current”，第 5 节又将多来源失败留待 API 设计。现有草图只有逐 Scope 的同步 adopt；没有中途 await 只能消除一类交错，不能证明后续 Scope 不会拒绝。

例如先采用 App A 的新观察、撤销 A 的旧资格，再因 App B 已关闭、在途调用或候选无效而拒绝。此时不能宣称整体仍维持原状态，也不能恢复已经撤销的旧资格。这里是方案层的反例，未运行或宣称实现已经存在。

**要求：**明确单 Scope、单 App、单 Source、多 Source 各自保证。可以选择按 App 隔离并如实表达部分采用／issue，也可以论证一个确有必要的更强边界；不能把跨 App 全局事务当作默认产品要求，不能新增通用事务管理器。无论选择哪种，都要给出第二个参与者拒绝、同步抛错／重入、模型请求尚未发出时的精确状态、清理和错误结果。此前全局保留旧资格的承诺在证明前不成立。

## 4. 下一份 API 材料还必须写清的合同

| 事项 | 已确认事实与下一步要求 |
| --- | --- |
| 交接容量 | 补充报告正确指出 current＋prepared 共同计费；Context／Observation 上限为 1 时不能无缝保留旧者并准备新者。分别说明限额 1／2、lease／字节不足时的结果，不偷借额度，也不将永久卡住称作可恢复。 |
| Ref 解析入口 | 正式 Observation 调用资格与底层 `SnapshotStore.resolveRef(selector)` 不同。后者不知道会话。另一合法 owner 保留旧 Snapshot，不代表旧会话可调用；若改变 raw API 签名或历史读取支持，必须列为公开差异。 |
| 提交完成 | 指定 SDK 实际 render／commit 接线、Worker 发布与 Host 接受的对应点。现有 coordinator 的 ready／epoch 和通知不提供等待 queued render 完成的接口；无 mutation 的 endCommit 也不一定发通知。不得只等待任意微任务或后台业务结束。 |
| Driver 分支 | 当前 inputs unchanged 会在模型调用前返回；stop、pause、disable、dispose、采用后模型失败、晚响应都需要有确定的持有／释放规则。跨轮保存不是当前 stop/dispose 已有能力。 |
| prepared 顺序 | 说明先准备 O1、再准备 O2、采用 O2 后尝试采用尚未采用过的 O1，以及旧异步准备迟到完成的行为，不能只禁止重新采用曾经退役的观察。 |
| 实际引用释放 | 同时检查 Store entries、观察注册、Source 捕获数组／闭包和实际调用 lease。覆盖无 lease 时 retire、显式最后 release、TTL lease 到期、degraded last-good；保留 App 当前状态与其他合法 owner，不能承诺清除外部 JS 引用或即时 GC。 |

## 5. 验证边界和未覆盖风险

本轮是源码和方案复核，未执行任何新合同。旧测试名称及历史结果只能说明已有保护需要保留，不能给拟议 adopt／flush 行为背书。上述长会话和组合采用结论分别是现有代码推导及方案反例，未伪装成已跑测试。

实现前仍需冻结返回类型、错误结果、消费者迁移、具体文件清单和正负测试。两种 Producer、正式包消费及完整 Driver 集成仍要各自验证。TS 7.0.2 隔离候选与 SDK 工具的既有限定批准保持；Driver 上游八条严格类型错误、原生 LSP 正常关闭失败、Host 预览 OPEN 和历史证据缺口均未因本次复核关闭。

## 6. 下一批范围、准出与 Prompt

下一批仅交付具体 API／迁移决策材料，详见 [任务书](MINIMAL_CORE_SRT_04_05_API_DECISION_TASK_2026-11-08.zh-CN.md)。不要求重做原 26 项盘点，不改冻结原报告，不实施生产。独立复核必须确认 R1／R2 有可检验的处理，才能向项目所有者提交重大公开合同选择。

> 沿用已核实的 SRT-04／05 输入与容量补充，补齐显式采用、提交完成和引用释放的最小 API／迁移方案。先比较每轮释放与跨轮 current 的 Scope／ledger 寿命；再明确单 Scope 至多来源采用的失败边界。提供准确签名、状态转换表、代表性消费者迁移 diff、精确文件清单及测试矩阵。任何额外持有、容量差异、raw 读取退出或公开入口变化都要明示。只写方案和评审材料，保留原始失败，不修改生产或运行 Host／模型／TS／LSP，不创建管理器、不削弱防重记录、不重开 D3。由负责人独立复核具体方案后再提交所有者决定。
