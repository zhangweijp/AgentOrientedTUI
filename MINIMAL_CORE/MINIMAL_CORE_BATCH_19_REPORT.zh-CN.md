# Minimal Core Batch 19 交付报告

**READY_FOR_REVIEW，生产补丁为空。** 完整旧 Ref 今天用于仍有效的观察、在途准备/调用，以及持有 Store 能力的可信历史查询方。已完成收据有自己的内容、身份、指纹和读取授权，实测可以在旧观察释放、旧源确实过期后独立回读。因而“最后一个合法持有者释放后立即清旧 Ref”会改变现有历史 ID 查询、历史 Ref 解析及窗口内重新 acquire 的能力；不必为此撤销另一份活观察，也不必一并取消同 Scope 中有权限的原收据回读。

## 1. 基线与真实入口

任务书 SHA-256：`cb4afa6d4b51fa0a024bc17e3e695b0f3b33afe3597fee0ba3cc8facdec5e98f`。B18 独立复核记录指纹：`a991a2a5f2a4ef29749060fcf4891795593d615e39311c820ff37ee007a4eefe`。本批保存开工实际工作树 **10,012 个既有路径**、Git 状态/HEAD/index，历史材料按现状保护，没有用 HEAD 重建产品基线。

SDK/Runtime 从 B12 的 294 份冻结输入及已签收 B14 R1、B15 R1、B16 patch 私有重建。复用 B18 首轮签收的真实 A/B Worker 快照和仅反转列表的 App 试件，不重新跑 Driver 会话或默认十分钟对照，不以此前产品/API 选择为前提。依赖版本/实际路径、输入和包入口在 `build-origin.json`。没有安装依赖或改锁文件。

为使审计也可历史复跑，另外封存 **576 份源码/合同输入**，均匹配开工指纹；包含相关主树生产、测试与合同，按类别统计，不把测试行数当生产采用量。默认复跑从归档读取，不要求今天的共享代码继续等于开工内容。输入原件和 Git index 不回写。

两类运行证据分开：

1. **默认 Source + 实际 Node Worker**：同一真实 App，两个旧 Context 和一个新 Context，实际观察、路由和业务 handler 均使用签收组合。
2. **正式 `@aotui/runtime/core` 消费**：复放 B18 两份真实 Worker 的完整 View/Ref/Tool 数据，在新可信 App instance/namespace 下使用实际 SnapshotStore、ScopeClient、参数编译和账本。使用真实受信 consumer handler 记录完整输入、产生最小结果，所有收据均由 `ScopeClient.invoke()` 生成；它不是 Worker handler，也没有手工造收据。只在该隔离 Core 设置 `historyTtlMs: 10` 和受控时钟，生产默认值未变。

## 2. 谁需要什么：合同与仓内调用分开

| 角色/入口 | 谁给资格、何时结束 | 是否需要完整旧 Ref | 当前支持与仓内使用 |
| --- | --- | --- | --- |
| 另一份仍有效的观察 | 可信 Scope 的 project 授予具体 View/Ref/binding，调用还需 validate/authorize；本观察 release 或 Scope 关闭才撤销自身资格 | 新调用要从本观察的准确源解析 payload，不能改读当前 B | Core 公开合同；Host Receiver/Worker/默认 Source 的真实生产路径。Source 可同时拥有重叠 Context |
| 已进入的准备/调用 | 现有 reservation、源 lease、执行/读取结算责任；取消或 release 不等于真实 Promise 已结束 | 执行所需源及 effectiveInput 需保留到现有责任结算 | Core 观察/调用实现中真实持有；不能只把“观察数为零”当成所有消费者结束。本批没有另做挂起工作新场景 |
| 仅持有历史 ID 的可信调用方 | 由可信装配者持有 Store handle；不是模型参数授予。`getById` 无 Scope ACL，`resolveRef` 核对准确 App/instance/View instance/Ref 来源；可在现有窗口内 acquire 成为 owner | 当前查询合同直接返回完整旧 Snapshot/Ref | 正式 `./core` 导出 `SnapshotStore`、`SnapshotLookup`、`RefSelector`、options 等。仓内直接使用集中在 Core 查找、观察 reacquire、调用准备和 Ref 解析；未找到 App/Host 另行按旧 ID 调用的产品功能，但不据此推断仓外无人使用 |
| 已完成收据的回读方 | 原 Scope 必须仍可用，结果仍在自身寿命内；每次 `canReadReceipt` 独立检查 | 本次最小结果回读不需要旧 Ref、旧观察或旧历史源 | 正式 `ScopeClient.invoke` 去重/回读合同；现有 Core 回归明确覆盖。默认 Source 释放入口后先拒绝调用，不能把低层能力等同于旧 Context 仍可用 |
| App 的当前业务数据 | App 与当前有效快照分别管理 | A 仍可能位于新列表第二项、其他当前页面或业务内存 | 不属于旧观察专属数据，不能因为旧第一项叫 A 就删除业务 A |

实际导出依据来自本次构建的 package exports 与完整声明原文，保存在 `consumer-audit.json`。`./core` 确实提供历史 Store 能力；Host/Worker 内部 Receiver 持有 Core 并装配 Scope，而公开 Runtime/desktop `createAppScope` 不接收任意历史 ID。`ScopeClient.observe` 接收 `all` 或 `viewIds`，不是历史 snapshotId 选择入口。默认 Source 每次通过观察入口取当前源，并把绑定交给本轮 Context；释放后的入口在调用 Core 前即拒绝。

仓内审计得到八处生产匹配行，归属 Store 自身查找、source binding acquire、Ref 准备、Observation 与在途源持有，**不是八个独立历史产品消费者**。Host 中 `customProviderStore.getById` 是提供商配置查询，已排除同名误匹配。历史/lease/收据的测试用法另列；正式低层合同即使仓内产品调用少，也不能仅凭搜索删除。仓外消费者、使用量及自定义 Producer/Host 的需求未知。

## 3. 顺序实测

### 3.1 真 Worker 的两位旧读者

默认 Source 先获得 A 的两份 Context，共享 **1 个 Scope、2 个 Observation**。用原工具提交重排后释放第一份：它的新调用得到 `SEMANTIC_CONTEXT_RELEASED`，业务零进入；第二份仍从原观察读到完整 A。再取当前 Context，读取同名引用得到完整 B；释放最后一份旧 Context 后，当前 Context 再读仍是完整 B。业务值逐字段匹配 B18 原件，递归冻结保持。

此链共 **3 份 Context、6 次 Source 执行入口调用**：1 次控制返回、3 次实际 Worker 读取（A、B、B）、2 次已释放入口拒绝。只有 4 次进入 Core。没有自定义授权放宽或最新 Map 查找。最后一份当前 Context 释放后，**全局关闭前** Scope 与交互逻辑字节已经为 0；最终 Runtime 关闭确认 Worker、待办任务及受管资源结清。

### 3.2 公开 Core：活观察与只知道旧 ID

公开 Core 先对 A 建立两份分别有 grant 的观察，再发布 B。释放第一份后，用其观察发起新 ID 调用得到 `OBSERVATION_UNAVAILABLE`，validator/执行授权/handler 均为 0。第二份旧观察持有 owner lease，越过本试件的 10 ms 历史期限仍实际调用到完整 A；当前观察调用到完整 B。释放最后旧观察后，在 **Scope 仍开启** 时进行准确旧源查询，得到 `SNAPSHOT_EXPIRED`，当前 B 继续可取。这是已经到期、最后 owner 释放后的查询清理，不把它说成 release 自带后台回收。

另一次发布 A→B 后，不建立任何观察，历史期限前 1 ms、activeLeases=0 时，按旧 ID 和准确 Ref 来源仍能取得完整 A。拿错误 instance 解析得到 `APP_INSTANCE_MISMATCH`。可信调用方在窗口内 `acquire(..., {lifetime:'owner'})` 成功，跨过期限仍可读；最后 lease 释放后的查询才为 `SNAPSHOT_EXPIRED`。因此“仍有合法读者需要旧值”与“无人持有也能凭旧 ID 回来查询/借用”是两条真实能力。

### 3.3 公开 Core：相同 invoke 请求回读原收据

在仍有读取资格的 Scope 中实际执行一次 `inspect_plan` consumer handler，得到 `entered-returned / succeeded` 收据。结果只含 `{id, call}`，完整 Ref 仅作输入与诊断记录。随后发布 B、释放该观察、推进隔离时钟，**先确认旧 Snapshot/Ref 均 `SNAPSHOT_EXPIRED`、historicalSnapshots/bytes/activeLeases=0**，再回读。

| 对原 ScopeClient 做什么 | 真实结果 | handler / validator / 执行授权增量 | 结果读取授权增量 |
| --- | --- | --- | ---: |
| 原 ID、原完整请求再次 `invoke` | 与初次收据完整字段相同，完成/到期时间及结果均未重造 | 0 / 0 / 0 | 1 |
| 新 ID，仍使用已释放观察 | `not-dispatched / OBSERVATION_UNAVAILABLE`，没有新业务 | 0 / 0 / 0 | 1，用于交付该拒绝收据 |
| 原请求，`canReadReceipt=false` | `RECEIPT_PERMISSION_DENIED`，未暴露原结果、未重新执行 | 0 / 0 / 0 | 1 |
| 恢复读取权限，再交原请求 | 仍是最初完整收据，拒读没有改写存储结果 | 0 / 0 / 0 | 1 |
| 关闭 Scope 后再交原请求 | `SCOPE_UNAVAILABLE` | 0 / 0 / 0 | 0 |

没有以新 ID 读取旧结果，也没有绕过 `invoke` 直接读取内部 Entry。这个子场景业务仅执行 **1 次**；与上一节的 A/B 调用合计，公开 Core 探针为 **9 次 invoke、3 次 handler/validator/执行授权、8 次结果读取授权**。与真实 Worker 的 3 次读取分开计数。收据能回读仍受原 Scope、receipt TTL/预算和权限约束，不承诺永久回读；本次也不推导所有 App 的结果都不包含业务数据副本。 本试件读取策略只依赖显式权限开关；若仓外 `canReadReceipt` 自行按 snapshotId 查询旧内容作授权判断，其兼容影响尚未覆盖，不能保证无需迁移。

## 4. 立即清除的兼容影响

以下“当前”有本次调用、声明与回归证据；“改变后”是依据这些事实的影响判断，未实施删除策略。

| 若真正最后一个合法源持有者释放后立即清旧 Ref | 哪个结果会变 | 可独立保留什么／边界 |
| --- | --- | --- |
| 仍有另一份有效观察或在途源责任 | 还没有达到“最后持有者”条件；若只按某一 Context release 或观察计数清理，会把本次仍应读 A 的请求变成拒绝/错误 | 保留其他观察与在途责任的 source/lease、不可变 payload。不能把它们强行撤销来降低计数 |
| 无 owner、尚在历史窗口内的 `getById` / `resolveRef` | 本次原本能取回完整 A 的查询不能继续得到同一值 | 这是 **R5 的公开低层行为变更**。`getById` 当前返回完整 Snapshot，不能悄悄把旧 Ref 改成当前 B或不完整对象还称结果等价 |
| 窗口内凭历史 ID 新 acquire | 本次原本可借用旧 A 的调用将不能建立新 owner | 同样是公开能力变化。是否允许这种新读者必须明确；仓内调用少不能替代兼容决定 |
| 原 Scope 的已完成最小收据回读 | 本次在旧源已过期时原收据仍能读，因此不必随旧 Ref 一起取消 | Entry 的请求指纹、结果、来源身份与 `canReadReceipt` 可按各自合同保留。不能顺手 close Scope、删除 Entry 或弱化每次读取授权 |
| 历史 View/Tool/身份查询 | 若直接删整份历史 Snapshot，影响比只清 Ref 更广，`getById/getTool` 等也可能失去原内容 | 身份、工具声明和已完成结果不等于完整 Ref。本批未实测“只留元数据”的新表示或保证其等价，也不设计兼容层 |
| 当前 A/B 和 App 业务状态 | 不应改变当前 B 或列表里的 A；本次旧源删除后当前 B 仍可取 | 原观察专属引用与仍被当前/App 使用的数据分开；逻辑字节归零不等于全部 JS 引用或 RSS 立即下降 |

最小影响面是旧源的 **无持有者历史重新查询/借用合同**，不是全部 Scope 或全部结果模型。最后一个读者须涵盖实际 owner lease、观察、reservation 与在途源责任，不能只看某个 Driver 的上一轮结束。是否退出 R5 的这个窗口、是否仍保留历史 View/Tool、对外怎样表达旧 Ref 不再可取，应交项目所有者裁决；不需要为本次影响说明增加新注册中心、历史仓库或把框架归属检查交给 App。

## 5. 验证、交付与限制

在项目根目录独立复跑：

```sh
python3 review-evidence/minimal-core-batch-19/reproduce.py
```

首轮 **14 条命令全部退出 0**：签收 patch 正向/whitespace 检查与应用、Runtime/SDK 私有重建、strict/skipLibCheck:false App 夹具编译、默认 Source/Worker 双读者、公开 Core 三类消费、既有合同回归、归档审计及完整结果核对。实际构建源码上运行四个既有文件：`scoped-interaction.test.ts`、`retention-lifecycle.test.ts`、`snapshot.test.ts`、`core/public-entry.test.ts`，**4 文件、262 项通过**。没有修改断言、新增 skip 或永久测试。首次完整日志/源/原始结果保存在 `runs/01`，没有用后续结果覆盖，也没有待处理的执行失败。

B18 的真实 Driver 连续会话、默认十分钟与 owner lease 的受控时钟记录只引用已签收原件，未算成本次重跑。本次公开 Core 的 10 ms 是隔离试件支持的配置，不是默认值变化；业务 handler 属于真实 Core consumer 层，不与 Node Worker 业务混称。未验证仓外采用率、所有 App 的 receipt 内容、挂起在途工作的新增情形、进程 GC/RSS、零 TTL/只清 Ref 的新实现或公开兼容迁移。没有发布或作出采纳/命名/API/历史策略决定。

交付生产补丁 [MINIMAL_CORE_BATCH_19.patch](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_19.patch) 为 **0 字节**，SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。正式报告、证据索引、保护核对和 `final-delivery.json` 提交独立复核，状态为 READY_FOR_REVIEW，不自行批准，不提交、push、merge、修改 Git index 或退出 Legacy。
