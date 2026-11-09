# SRT-15 已验收入口剩余清理：独立验收

2026-11-09。裁决：**APPROVED**。批准下面精确的 20 路径候选；没有待修订项，可由 SRT Owner 选择性采用。本裁决写入时共享生产尚未采用。Clean 执行完整清理，Minimal Core 负责人独立审查补丁、实际源码和验证结果；没有用执行者自审代替批准。

## 对象与范围

[唯一任务](../SRT/SRT-15_REMAINING_CLEANUP_CLEAN_TASK_2026-11-09.zh-CN.md)、[执行报告](../review-evidence/srt-15-remaining-cleanup-20261109/REPORT.zh-CN.md)、[完整补丁](../review-evidence/srt-15-remaining-cleanup-20261109/srt-15.patch)。

- patch SHA-256：`afe05b9c94f13b4e76369d840422bc2ab7f14bbee72c5954205021a8e25cf635`。
- report SHA-256：`e54f6676be62bad9bfd218b6e08170da4fc10f456dbc1e39eb6e2dfe3e5395bf`。
- changes SHA-256：`3114a415d05e6c7ddae93766d052b559dd77ddd729bb0c7c4f11567df573e7c2`。
- 执行候选：`.tmp/srt-15-remaining-cleanup-20261109/candidate`；负责人重放副本：`.tmp/srt-15-minimal-core-review-20261109`。

负责人独立核对当前共享树与 423 个 Runtime／SDK 原始输入相同，在仓库外临时目录实际重放 20 路径 patch，再得到与执行候选一致的 419 个输入。4 删除、16 修改，净减 191 行；三个测试仅改 import，没有削弱断言。Core 的 51 个输入逐字保持，包版本、依赖、package exports、构建配置和 SRT-13 已采用实现没有变化。证据见 [identity.json](../review-evidence/srt-15-minimal-core-review-20261109/identity.json)。

## 去留与行为判断

**SDK 删除项没有保留职责。** `viewGeneration`／`sdk_mount_*` 只在 View 内产生并写入私有 Context；当前源码和直接消费者没有读取。公开 `useViewContext()` 只返回 `meta`，`ViewRuntimeContextValue` 和 Context 本身不在包公开入口导出。`containerRef` 只有赋值，没有读取或外部消费者。删除这些字段与 Hook 后，真正的 `instanceRef`、Runtime `mount/unmount`、DOM ref 回调、Ref 注册及 Tool 所有者清理均原样保留；没有把实例身份改成 View 逻辑 ID，也没有将释放责任交给 App。

**四个 Runtime 内部聚合文件只增加转导出层。** 删除的是 `engine/core/index.ts`、`engine/app/index.ts`、`spi/core/index.ts`、`spi/app/index.ts`。它们不在 package exports 承诺中，调用方现直接引用同一源模块。负责人检查原转导出内容、受影响运行时模块的创建位置以及改后消费者：实际 Worker、Pool、Desktop 和订阅由原实例创建／关闭流程负责，没有因删除聚合入口遗漏必需初始化。原公开 AppRegistry、SPI factory guard 等仍导出同一实现和类型，未新增兼容壳或替代体系。

**当前语义继续由原内核承担。** 提交、观察、调用、Ref 解析、来源绑定和释放实现没有改。`ordinary-v2`、`ordinary-params-v1`、`ViewSnapshotV2` 等有现存职责的合同继续保留；旧能力的拒绝分支继续保留，不能按名字删掉。生产注释改为当前职责与真实 API，不涉及并行 SRT-14 的作者文档、示例或 skill。

四项原则的结论：删掉无读取字段和内部转导出；保留行为仍由 Runtime View 身份、SDK commit 与现有实例生命周期承担；真实重挂／Ref／关闭和双 Producer 用例证明行为；App 作者概念数量不变，维护者少跟踪四层内部转导出和一套没有作用的 SDK 身份计数，没有新必学概念。

## 独立验证

| 验证 | 实际结果 |
| --- | --- |
| Runtime → SDK 重建 | 均退出 0；Runtime 342、SDK 68 件产物与执行候选逐字节一致。 |
| Runtime 相关测试 | 7 文件 **80/80**，含实际 CLI 文件 `cli.list.test.ts`、Registry／Manager／Desktop、公共入口和真实双 Producer 16 项。 |
| SDK 相关测试 | 7 文件 **80/80**，覆盖同类型多 View、Ref 所有权、同 ID 重挂的 Runtime 身份、禁用／重启用、最后实例关闭、嵌套拒绝和投影。 |
| 严格公共类型 | `tsconfig.public-api-types.json`、`tsconfig.static-tools.json` 均退出 0，strict／exactOptionalPropertyTypes／skipLibCheck:false。 |
| 公开入口 | 独立重建后的六个运行时值导出集合与改前／执行候选相同；源类型定义保留，内部声明 import 路径随本次去重变化，未声称 d.ts 逐字不变。 |
| 退出产物 | 四个删除文件对应的 12 个 JS／map／d.ts 在独立干净构建中全部不存在。 |

独立合计 **160 passed、0 failed、0 skipped**，不与执行者同一集合累加。命令和完整输出见 [run-review.py](../review-evidence/srt-15-minimal-core-review-20261109/run-review.py)、[测试结果](../review-evidence/srt-15-minimal-core-review-20261109/tests-summary.json)、[产物与导出核对](../review-evidence/srt-15-minimal-core-review-20261109/artifact-and-export-check.json)。

执行方首条命令写错 CLI filter 后补跑真实文件的记录保持；负责人本次直接使用正确文件名，一组收齐 80 项 Runtime 测试。负责人最初清点把副本额外 12 件参考文件计入 Runtime／SDK，断言发现后将清点范围限定为这两个包，尚未复制或修改输入；该夹具说明保存在 identity.json，不算生产失败。

## 人工签收判断及未覆盖风险

本次拟删除项是私有字段和内部转导出，**没有一个退出用户公开行为或当前支持入口的对象，因此本批新增人工签收项为 0**。已有 Planning／Ref／View 签收保持。此判断限于本次实际去留，不等于证明仓库中任何历史代码都能删除，也不等于获得全面 Legacy 退出或发布授权；保留合同不成为强制继续删除的欠账。

本次没有重新完成正式 tar 安装矩阵、全仓测试、GUI、真实模型或 TS／LSP 调查；真实双 Producer 用例以新 dist 和既有依赖运行，不能冒充正常包安装。公开导出、严格声明、真实调用及退出产物均有本轮证据，未发现当前补丁的剩余行为风险。用户 Host、配置与数据库未被操作。

## 下一步范围、准出及执行 Prompt

下一步是 SRT Owner 采用这 20 路径，保持 20 份 before 备份；重建根 Runtime → SDK，确认 16 个 after 与四项源码／12 件产物删除一致，再更新唯一索引。本次 160 项已独立通过，采用时不追加同类完整复核或人工流程。准出是实际采用与批准对象相同、根构建通过、记录准确。

> 选择性采用本裁决批准的 SRT-15 精确补丁，逐路径核对 before，使用已备份原件；不要整树覆盖或额外删除 Legacy 名称文件。采用后核对 16 个 after、四个源码删除与 12 件产物退出，执行根 Runtime／SDK 必要构建并保存简明采用记录。更新唯一索引为本轮剩余冗余清理完成，保留当前 ABI/profile 与其他专项边界；不重新索取已有人工签收、不提交推送发布。

后续完整工作已经在进行：[SRT-14 新上下文 Agent 作者试用](MINIMAL_CORE_AGENT_AUTHOR_DELIVERY_TASK_2026-11-09.zh-CN.md)，指定执行agent负责固定公共包输入下的小 App、真实行为与有限修复。该项整份交付后再集中验收；不因本批通过自动启动新的协议、全局错误模型或其他未定方案。
