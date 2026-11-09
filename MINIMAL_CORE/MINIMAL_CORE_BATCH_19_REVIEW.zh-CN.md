# Batch 19 独立复核 · 旧页面和工具收据各要留多久

**APPROVED。签收范围是旧页面读取与收据回读的取证。** 我从交付原件重新构建，在新目录复跑 14 步，四个现有 Core 测试文件共 262 项通过。另用真实 Worker 连续更新 65 次，查明了旧快照确实消失后，谁还能读当时的收据。生产补丁为 0 字节，SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。历史保留规则的变更交项目所有者决定。[执行报告](MINIMAL_CORE_BATCH_19_REPORT.zh-CN.md) · [独立核验记录](review-evidence/minimal-core-batch-19/owner-review/final-verification.json)

## 用一份计划说明

Planning 第一版列表把计划 A 排在第一位。两位读者都打开这版。App 调整顺序，第一位变成 B。原来的两位读者各自持有已获授权的观察。

| 此时做什么 | 实际得到什么 |
| --- | --- |
| 第一位读者关闭旧页面，第二位仍开着 | 第一位的旧工具立即拒绝新调用。第二位照样读到完整 A。打开新版后，同一个“列表第一项”的名字读到完整 B；最后一位旧读者离开后，新版仍读 B。 |
| 所有旧读者已离开，有权限访问底层 Store 的程序只拿旧快照编号来查 | 在现有保留窗口内仍可取回完整 A，也可以重新借用这份快照。用错 App 实例会被拒绝。原件到期或被容量淘汰以后，再凭编号查不到 A。 |
| 工具在 A 上已经执行成功，旧快照随后被清掉 | 原会话还开着、收据还在有效期内、当次有权读取时，重交同一个调用得到完整原收据。业务进入次数增加 0，结果读取权限检查增加 1。另发新调用或换会话，都不能借这个编号执行旧业务。 |

我把每次 Source 调用关联到当时的页面、绑定、Worker 实收参数和 Core 生成的收据。默认 Source 的三份 Context 共用一个 Scope，两次已关闭入口都在进入 Core 前拒绝，业务实际读 A、B、B。两位读者独立释放后，最后关闭当前 Context 时，Scope 和交互逻辑字节已经归零。[真实 Worker 双读者原始记录](review-evidence/minimal-core-batch-19/runs/01/evidence/live-readers.json)

公开 Core 的另一组受控实验只在试件里把历史期设成 10 毫秒，并使用能记录实收参数的受信业务函数。九次请求中，业务、参数校验及执行授权各发生三次，收据读取授权八次。临时拒绝读收据会返回 `RECEIPT_PERMISSION_DENIED`，恢复读取权限又得到最初那份收据。新调用使用已释放的观察，拿到一张 `OBSERVATION_UNAVAILABLE` 拒绝收据，交付它也要检查读取权限。[原始请求、权限与结果](review-evidence/minimal-core-batch-19/runs/01/evidence/core-readers.json)

## 负责人补测

我还保留了新版页面，在默认 Runtime 上让同一个真实 App 成功提交 65 次更新，把第一版挤出默认 64 项历史窗口。清理前能按旧 ID 读快照、取 Ref、查工具描述。淘汰后这三个查询均被拒绝，尝试重新借用得到 `SNAPSHOT_EXPIRED`。此时还有其他 64 份历史记录，当前页面仍有效。

随后把最初的一次成功调用原样交回原 Scope，整张收据逐字段相等。Worker 日志里从始至终只有最初一次读取 A。用同一调用号改参数，得到 `INVOCATION_ID_CONFLICT`。关闭最后一份 Context 后，原 Scope 返回 `SCOPE_UNAVAILABLE`；重新打开的 Scope 收到这份旧请求，给出拒绝收据。两次独立运行得到了相同的业务与授权计数。[负责人探针](review-evidence/minimal-core-batch-19/owner-review/worker-receipt-after-eviction.mjs) · [首次完整结果](review-evidence/minimal-core-batch-19/owner-review/worker-receipt-after-eviction.json)

## 需要所有者决定的一件事

**我建议，页面已被新版取代，而且最后一位合法读者和在途调用都放手后，Runtime 可以清掉只属于旧观察的完整 Ref 数据。** 仍有读者时要能读 A；App 和新页面还在使用的 A 要保留。已完成的收据按自己的权限和期限读取。这个选择会改变目前受支持的一种用法：可信的外部程序能在窗口内仅凭旧快照编号取回整份旧数据，或重新借到它。仓外有多少程序依赖这一点目前未知。

影响面可以从公开 Store 的四个入口核对。`getById` 返回整份快照，`resolveRef` 查准确来源的值，`acquire` 可以建立新的借用。`getTool` 返回工具描述，现行实现也先按快照 ID 查找。删除整条快照会同时影响描述查询；若计划保留描述，需要另行明确旧 ID 所支持的内容，并给现有外部调用方迁移说明。已完成收据则由现有 Scope 的调用号、请求指纹、结果和独立读授权支撑。上述事实来自已签收的 M4.2 加三份 Minimal Core 补丁的组合；挂起工作在新策略下的行为、仓外调用、自定义读权限代码、其他 App 写入收据的内容及进程实际内存仍待相应验证。[Store 实现](runtime/src/core/snapshot/store.ts) · [收据读取实现](runtime/src/core/invocation/scoped-interaction.ts) · [导出和调用方审计](review-evidence/minimal-core-batch-19/runs/01/evidence/consumer-audit.json)

我核对了执行者封存的 32 份文件、22 项历史引用、294 个构建输入、576 个静态审计输入和开工的 10,012 个既有路径。清单 SHA-256 为 `1ad75a33e85aadf002bc452558b19c4ca5694b5680d31d8cb13f3c51a6d011d7`，报告为 `bdc40a5bb22196100850abeb9dcb30ed597bb386059e894f27560967ab6eaeb9`。本批保留现有所有权、查询和收据三个入口的分工，新增 App 作者步骤为零。[交付清单](review-evidence/minimal-core-batch-19/final-delivery.json) · [独立逐项核验脚本](review-evidence/minimal-core-batch-19/owner-review/check-delivery.py)

## 下一批转回作者接口

**Batch 20 把两项已经各自验证过的行为放进同一套实际安装的包。** 从 SDK 工程签收的 M4.3 重建，再叠加三份已复核的引用补丁。准出看三件事：在 App 自己的关闭回调报错后旧工具能否停住，Planning 能否从该套包的默认路径读到正确的计划，以及普通工具注册目前在哪一步拒绝新引用参数。执行者交可复跑的包、正反例和精确边界，技术负责人再独立签收。当前 B19 的签收不依赖旧数据策略或作者评测的裁决。[Batch 20 范围、准出与 Codex Prompt](MINIMAL_CORE_BATCH_20_TASK.zh-CN.md)
