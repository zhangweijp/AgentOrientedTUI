# Batch 14 独立复核

## 首版结论

**CHANGES_REQUESTED。** 首版补丁为 `386da95b51511428fa318b22719cf22176b370f95aabcb23019dfe63394388ee`，交付清单为 `25c5c9998ba7e748f65a184ad0b1aafefbfa6832245feac600b673815d7e2c5f`。当两种业务数据恰好长得一样，首版无法区分它们。另有一种严格 TypeScript 允许的写法，会让应用作者以为拿到的是字符串，而数据校验器实际给出对象。修订限于原先批准的三个隔离源码副本和本批样例。[签收核查](review-evidence/minimal-core-batch-14/owner-review/first-verification.json)

| 复核场景 | 首版实际结果 | 修订的准出要求 |
| --- | --- | --- |
| 同一工具的目标从用户改为订单，两种对象都只有字符串 `id` | SDK 导出的 JSON 相同，完整合同的 SHA-256 同为 `4cf7a6fa5759dec958c30f80df6a6aec9cdab730e8d3d44cd56ad5ecea834193`。用 TypeBox 的 `$id` 指明种类也被拒绝。执行者测试的 Plan 与 Phase 在字段上本来就不同。 | 让一份声明表达业务种类，用独立进程证明同形异类可以区分、同类合同能够重现。 |
| 用普通 `Type.String` 复用计划引用的选项 | 作者直接调用 `target.toUpperCase()` 能通过严格编译。计划对象也通过校验，两者直接相接就抛出 `TypeError`。此次探针直接调用样例函数，旧 Runtime 仍然挡住在线执行。 | 作者入口应能拒绝缺失必要类型信息的声明，普通字符串、正常引用和 Core 读回有效 JSON 应分别通过自己的对照。 |
| 读回的 JSON 将名字长度下限删除或设为零 | 首版接受空字符串作为引用名。 | 跨进程的输入也要执行名字非空的规则。保留普通字段填空字符串及引用名逐字使用的能力。 |
| 普通工具接收 100 个没有长度约束的字符串 | 原版无须逐字符遍历，首版对 100 个元素都进行了这项额外工作。这里只计遍历次数。 | 把新增的深层校验用于需要它的字段，普通数组维持原有处理成本。 |

[严格类型与同形类型探针](review-evidence/minimal-core-batch-14/owner-review/author-boundaries.ts) · [独立返回值](review-evidence/minimal-core-batch-14/owner-review/author-boundaries.json) · [空名与普通数组对照](review-evidence/minimal-core-batch-14/owner-review/raw-and-ordinary.json)

首版的有效结果保留。我在新建的两个副本中重建包，复跑 21 个步骤，核对正式补丁只改三个文件，正向得到候选、反向还原。原有 Core 224 项、SDK 17 项在基线和候选均通过。实际发布的计划、列表、列表元素和空列表通过结构校验，九个错误数据或超限输入被拒绝。原包和候选的既有普通工具注册入口都在进入工厂和业务函数前拒绝候选声明。我逐项核对了 118 份首版交付、9,102 个开工文件、294 份冻结构建输入，以及所用快照值的原始位置。[交付报告](MINIMAL_CORE_BATCH_14_REPORT.zh-CN.md) · [负责人独立重放](review-evidence/minimal-core-batch-14/owner-review/first-verification.json)

这轮验证覆盖一个已知名字在两端应当具有的数据形状。框架仍需在实际调用时检查名字来自哪个 App、哪个页面和哪次观察。线上模型、Worker 协商、公开 API 和最终 Semantic 验收另有各自的准出条件。
