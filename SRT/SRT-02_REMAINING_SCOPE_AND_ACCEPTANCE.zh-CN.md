# SRT-02 剩余范围、验收条件与下一批任务

2026-11-06，SRT Owner。**状态：READY_FOR_SCOPE_REVIEW。** 本轮交付为静态核查和下一批任务方案；没有修改生产代码、执行项目模块或批准共享采用。SRT-02 整体仍未完成。全局事项状态继续由 [deepseek_review.md](deepseek_review.md#review-todos) 维护，本文只展开 SRT-02 的交付条件。

## 1. 当前可以继承什么

已签收的能力是：普通 ViewType Tool 消费一个必填对象 Ref；typed `useDataRef` 发布对象；`useArrayRef` 的一个元素可作为对象 Ref；Planning 的十个对象操作使用 Ref，创建与关闭保持应用自身的普通参数／无参数合同。

SDK、Planning 和受控 GUI 均有独立签收。SDK 91 项、Planning 15 项及 27 次 Worker 调用、GUI 5 次业务调用属于历史精确候选的实测，**本轮没有重新运行它们**。GUI 结果经 Chat/TUI 切换观察，不证明首次预览或持续停留时自动刷新；真实模型使用和最终 Semantic 验收也不在技术签收内。[技术裁决](MINIMAL_CORE/MINIMAL_CORE_TYPED_REF_AND_PLANNING_REVIEW_2026-11-06.zh-CN.md) · [GUI 裁决](MINIMAL_CORE/MINIMAL_CORE_PLANNING_REF_GUI_REVIEW_2026-11-06.zh-CN.md)

| 本轮实际核对的包 | SHA-256 | 解包普通文件数 |
| --- | --- | ---: |
| typed Ref SDK 最终包 | `7573cc0b73d1aa480edf68847617da1d9c85e4bab616bfebfd5b6f124baa5e5b` | 90 |
| B23 Runtime | `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6` | 388 |
| Planning 单目标 Ref 包 | `ac41d296facd7503d5838a57dc0507aee3c1a32e9beba576505143d88e8140c1` | 46 |

原 Planning 测试实际使用 SDK 首包 `4cdb78f2abe6ee847c58b2b0515d5c842faa9560e32a2021267b988f30328344`；首末包只差 README 的既有独立核验保持原事实，不能改写成当时运行了最终包。

本轮在新目录 `.tmp/srt-02-scope-audit-20261106/` 只解包和阅读，不导入 JavaScript。逐文件 SHA 见 [identity.json](review-evidence/srt-02-scope-20261106/identity.json)。共享 HEAD 为 `8938449925ada2f92e072e1c0492af8f2428d14f`，开工状态有 354 条记录，其中 41 条未跟踪；这不是干净的生产基线。

## 2. 缺口不是同一件事

以下代码位置指上述精确包的 `dist`，不是共享源码。每条位置、原文和文件 SHA 保存在 [static-findings.json](review-evidence/srt-02-scope-20261106/static-findings.json)。

| 能力 | 当前事实 | 尚需完成的条件 |
| --- | --- | --- |
| 单个对象及数组中的一个对象 | 已有正式 profile、来源验证、真实 Worker 和 Planning 证据 | 后续扩展必须保留其身份、授权、预算和关闭行为 |
| 整列表发布 | `useArrayRef.js:33` 同时注册整体和元素；整体名字如 `Task[]:tasks`，元素如 `Task:tasks[0]`，两者 metadata 的 refType 都是 `Task` | 发布成功不等于普通 Tool 可以消费整体 |
| 整列表消费 | `ordinary-parameter-contract.js:205` 要求 payload Schema 为 object；`snapshot-value-arguments.js:63` 再次拒绝数组值 | 贯通声明、原观察取值、授权、Worker 校验、handler 数组类型和真实包消费 |
| 多个 Ref 参数 | 正式 profile 在 `ordinary-parameter-contract.js:203` 拒绝；preparer 在 `snapshot-value-arguments.js:65` 每次从 rawArgs 组装 | 后续需要正确累计解析结果及逐来源对应，不能只删除声明限制；这不是当前单 Ref 合同的可达缺陷 |
| 可选 Ref | profile 要求必填；preparer 在 `:47` 无条件要求字符串 | 后续明确缺席跳过，传入无效值则失败；不能把解析失败当缺省 |
| Ref 数组／多选 | profile 拒绝，当前 preparer 只枚举顶层 Ref 字段 | 后续需要逐元素来源表达、顺序、拒绝与总预算验证，不与一个列表 Ref 混为一谈 |
| 旧 Snapshot Tool 退出 | 仍有公共导出、协议、执行分支和消费者 | 完成必要能力与契约测试迁移后，删除专属包装；保留新路径仍使用的来源、预算和资源责任 |

`refParam` 的 Schema witness 与 `ArgsOf` 已提供 handler 类型推导；本轮不提出全局类型描述符、第二个解析器或另一种 Tool。typed `useDataRef` 只接受对象，整列表应复用 `useArrayRef`，不顺带放开该 Hook。

SRT-05 的“新观察正式接替后自动撤销旧资格”单独维护。当前合法保留旧 Context 的来源测试不能算它已经完成；本批也不修改 Observation 采用策略。

## 3. 共享采用与旧入口退出的真实前置

本轮按 B24 清单重新计算了共享源码／配置的 600 条记录及消费者输入的 31 条记录，全部与原指纹一致；仅涵盖清单列出的文件，不代表全仓无变化。[核对结果](review-evidence/srt-02-scope-20261106/shared-drift-vs-b24.json)

因此 [B24 独立采用审查](MINIMAL_CORE/MINIMAL_CORE_BATCH_24_REVIEW.zh-CN.md) 的职责差异仍适用：共享 SDK 作者接口不同，且保有配置 getter 边界、终态规则、响应单次捕获、普通 registration 去镜像、WorkerError 诊断和 B09/B10 的 Host/Driver 保证。后续候选不得通过整目录覆盖共享树采用；本轮没有重跑 B24 探针或生成集成 patch。

针对命名的 SDK、Runtime、App、Host 和 Driver 源码／文档／测试根目录，新静态扫描记录旧入口相关文本 255 处、64 个文件，其中按路径分类为生产 16、测试／夹具／示例 34、文档 14。没有发现 App `src` 直接调用 `useViewSnapshotTool`。这是文本引用清单，不能证明动态入口都不存在，也不是可以删除 64 个文件的结论。[完整输入、命令及位置](review-evidence/srt-02-scope-20261106/legacy-consumers.json)

退出时须逐项映射：

- SDK Hook、公共导出、类型和文档迁往普通 ViewType Tool 的声明及 App 绑定。
- `snapshot-value-sdk`、`dual-producer`、`ref-v2-slice`、`w10-package-consumer` 等消费者迁移；保留它们验证的来源、失效、预算和关闭语义，旧 API 专属断言才可退出。
- `snapshot-value-v2`、旧 View-instance Tool／target selector 和专属 Ref 协议分支按依赖核对后退出；不得整删仍承担普通 Tool 责任的 `view-owned-tools`。
- `snapshot-value-arguments` 同时承载旧准备函数与新的 `prepareViewTypeParameters`。不能按文件名删除；新调用链、参数额度、`Observation.refs`、grants、source binding 与 Snapshot 引用释放继续保留。

这是 SRT-02 的专属入口收敛条件，不替代所有者对整体 Semantic／Legacy 退出的验收。

## 4. 建议下一批：一个必填整列表 Ref

**该批仍为待范围复核方案，不是已实现能力或实现准出。** 先补项目所有者明确要求的“数组整体可消费”，再处理多 Ref、可选和多选；各项最终仍须满足全局 SRT-02 目标。

沿现有签名表达，以下是下一批待验证的用法：

```ts
const TaskSchema = Type.Object({ id: Type.String(), title: Type.String() });
const inputSchema = Type.Object({
  tasks: refParam('Task', Type.Array(TaskSchema)),
  title: Type.String(),
});
// 模型：{ tasks: 'Task[]:tasks', title: 'New title' }
// handler：tasks 为 readonly Task[]；普通 title 原样保留。
```

内部 id 保留在数据和 Schema 中供 App 检查，不要求模型抄写实例业务 ID。完整 Ref 名原样选择，不能去掉类型前缀或推断属性路径。`Task[]:tasks` 的 payload 是列表，metadata refType 仍为 `Task`；`Task:tasks[0]` 的 payload 是单对象。消费者 Schema 区分这两种载荷，不能仅凭相同 refType 接受错形状输入。

首批范围为一个必填顶层 `Array<Object>` Ref，可附带已支持的普通参数；保留单对象场景。空数组是否可用由声明的 `minItems` 决定，元素结构及 `maxItems` 沿既有 Schema 校验。数值、字符串或嵌套数组作为列表元素不在本批新保证中；声明边界必须明确拒绝未支持形状，不能不验证就声称支持。

| 预期文件范围 | 本批责任 |
| --- | --- |
| `runtime/src/core/tool/ordinary-parameter-contract.ts` | 正式 profile 的整列表声明与模型／有效输入校验；保留多 Ref、可选、Ref 数组拒绝 |
| `runtime/src/core/tool/snapshot-value-arguments.ts` | 原观察的一个获准列表解析、既有总预算、来源与释放；旧 Snapshot 函数保持原合同 |
| `sdk/src/tools/view-type-tool.ts`、SDK 作者文档 | 仅在运行验证成立后同步 helper 支持范围；不新增 helper 签名、descriptor 或 Hook |
| 相关现有测试、类型输入、真实包消费者夹具 | 迁移“整列表不支持”的预期，补完整边界；其他拒绝和身份断言保留 |

Worker 的 `adapters/ordinary-invocation-v2.ts` 已复验 raw/effective 与逐字段 provenance，预计可以复用；该判断是静态推断，须由真实 Worker 证据确认。若需要修改 wire、capability、公开参数签名或额外生产文件，先提交具体失败和范围修订，不能将其夹带进两文件修改。测试夹具可以更新合成业务状态证明写操作；不向 Planning 添加批量业务功能，不修改 Host、Driver 或 App 业务服务。

## 5. 必须满足的行为验收

| 门禁 | 必须证明的行为 |
| --- | --- |
| G-A 声明与类型 | 从实际 tar 安装，以 TS 5.3.3／5.9.3 的 strict、exactOptionalPropertyTypes、skipLibCheck:false 验证 readonly 对象数组；字符串 handler、数组 push、元素写入等不安全例在预期位置拒绝；多 Ref／可选／Ref 数组仍明确拒绝 |
| G-B 发布与形状 | Preact `useArrayRef` 和普通 TS Producer 按公共合同发布等价整体／元素；实际名字、metadata、payload 对应。整列表传给单对象参数、元素传给列表参数、错类型、模型直接传对象／数组均拒绝；空列表分别覆盖允许与 minItems 拒绝 |
| G-C 原观察与授权 | O1 持有的列表在后续重排／替换后仍来自 O1；O2 读取新列表；释放 O1 后拒绝。不可见、跨 App、同名来源歧义、失效 activation、授权等待期间撤销均有正确阶段和业务进入计数；不宣称 SRT-05 自动替换已完成 |
| G-D 真实调用 | 普通 ViewType mutating Tool 通过真实 Worker 恰好进入一次；授权输入、wire、handler 的列表和普通字段一致；收据与 View 分离，业务前置由夹具 App 检查。不能借用旧只读 Snapshot Tool 或直接调用 handler 冒充通过 |
| G-E 容量与关闭 | 现有 raw/effective/envelope 总量及 Schema maxItems 分别覆盖边界和超限；数组全部元素计入现有额度，不按元素重置预算。拒绝不新增业务副作用；来源 lease、Context、scope、在途操作与最终关闭如实记录，保留原保护数值 |
| G-F 包与兼容 | 新包安装载荷与 tar 一致；基线／新 SDK × 基线／新 Runtime 四组合验证单对象回归和整列表行为。这里“基线 SDK”指 7573cc0b 包，不是共享 SDK 0.3。旧 Runtime 拒绝未支持声明须明确发生在业务前；不得静默回退、只看版本字符串或只测 specimen 编译器 |
| G-G 准出 | 保存有效先失败、最小 patch、实际命令／环境／退出／原始日志及资源事实；受影响 SDK／Core／Worker 回归完成。由实现者之外的负责人独立复核精确源码与包，才能签收本批 |

保留当前 `view-type-parameters-v1` 与 V4 wire 能否表达这一增量，须结合上述四组合验证作出判断，本文不预先批准新的协议版本或假定旧 Runtime 已支持。测试开始前固定支持矩阵和预期失败阶段，不能看结果再改口径。

## 6. 所有权与执行前置

SRT Owner 负责本任务范围、公共作者合同、验收矩阵和总体证据；拟由 SRT Owner 在全新独占目录实施，Minimal Core Owner 独立复核，避免与其 Host 线并发修改相同文件。此次只交范围包，尚未启动该实现。

重建源码须从固定 M4.3 Git `853495dd9954eb4f8a91998bcc59e19326765981` 及已签 B14 R1、B15 R1、B16、B22、B23、typed Ref 补丁链追溯，或使用已封存源码原件。具体输入 SHA 见 [source-inputs.json](review-evidence/srt-02-scope-20261106/source-inputs.json)。先在新目录核对重建源码／声明与精确基线包的一致性，再修改；不直接运行可能写回旧证据目录的历史 reproduce 脚本。

当前任务不依赖 Host 预览修好，也不使用该诊断脚手架。消费者必须显式使用自己的合成配置、路径和数据，先静态确认入口不会导入 Host 的默认 singleton 或读取默认用户 Registry；无法确认就不得运行该消费者。不要用真实私有路径测试“应该被拒绝”，不改 HOME、不重置或重跑已交接手测环境。真实 Worker 的实际依赖、入口和资源归属必须进入独立复核；纯编译不能替代 Worker 验收。

MC-HOST-PREVIEW-01 的[静态交付已独立签收](MINIMAL_CORE/MINIMAL_CORE_HOST_PREVIEW_STATIC_REVIEW_2026-11-06.zh-CN.md)，范围仅为分析与建议。其事故／预检 CHANGES_REQUESTED、第三轮运行 NOT_ADMITTED、缺陷 OPEN 均保持；Host 运行验证须满足自己的隔离准入条件。

## 7. 可直接下发的下一批 Prompt

> 在本任务包获得独立范围复核后，由指定实施 Owner 创建全新独占目录。先核对 source-inputs、三份精确包与实际源码来源；禁止覆盖共享 main、冻结候选或手测状态。目标仅为普通 ViewType Tool 的一个必填顶层对象列表 Ref，复用 `useArrayRef`、现有 `refParam('Task', Type.Array(TaskSchema))`、同一参数编译／原观察解析／授权／Worker 链。先建立有效的整列表声明／调用拒绝基线，再完成最小修改；保留单对象与普通参数、预算、来源和关闭保证。不得放开多 Ref、可选、Ref 数组、属性路径或修改 Observation 采用；不新建解析器／注册中心，不新增 Planning 业务。先审查消费者入口及合成配置，禁止导入 Host 默认 singleton 或碰真实私有状态。按 G-A 至 G-G 保存正反例、双 Producer、四包组合、真实 Worker 与资源结算；不以缺依赖或包装器 exit 0 记分。发现需扩大生产文件／协议范围时提交有证据的修订，不静默扩展。同步支持文档，封存独立 patch、原始失败与精确 tar，交 READY_FOR_REVIEW，由 Minimal Core Owner 独立裁决；技术签收不代表共享采用、发布或最终 Semantic 验收。

## 8. 本轮证据边界

本轮新增证据为包身份核对、静态责任位置、B24 输入漂移检查及旧入口文本清单。没有运行 Runtime／Host／Worker、模型或 GUI，没有改生产源码，没有新测试通过数。一次定位脚本因同一判断同时存在于新旧准备函数而中止，修正为精确函数范围后完成；[原失败](review-evidence/srt-02-scope-20261106/audit-attempt-01.json)保留，不当作产品失败。

本轮独立范围复核：**待 Minimal Core Owner 裁决**。若裁决需要修改，保留提交版本与指纹，再修改任务包。独立范围复核只检查任务是否具体、边界是否正确，不代替下一批实现的测试及独立技术签收。
