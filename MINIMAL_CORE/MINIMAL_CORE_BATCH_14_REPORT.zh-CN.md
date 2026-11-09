# Batch 14 · 可序列化的 Ref 参数合同隔离试件

**READY_FOR_REVIEW。** 已贯通 TypeBox 声明 → SDK 捕获 → 完整 JSON → 另一进程编译 → 名字输入检查 / 已取得值的结构校验。旧包和候选的默认普通注册入口均拒绝新声明，工厂与 handler 进入数为 0。没有接通在线 Ref 解析、授权或 Worker 执行；这些仍是后续合同与产品决定。

## 作者写什么

使用 Batch 12 签收的 Plan Schema 和 Planning 业务类型，分别声明：

```ts
Type.Object({ target: RefValue(Plan), literal: Type.String() });
Type.Object({ target: RefValue(Type.Array(Plan)), literal: Type.String() });
```

`RefValue` 这次有实际实现，生成带完整值 Schema 注解的 TypeBox 字符串；不再只是 `declare`。`target` 在导出 JSON 中仍是 `type:'string'`，模型形式输入是 `active_plan` 或 `Plan[]:unfinished_plans`。业务参数类型分别推导为递归只读 Plan、Plan 数组，并实际传给要求真实 `PlanningPlan` 只读类型的函数。普通 `literal` 即使等于引用名也保持原字符串，不查表、不转换、不补默认值。

新增的每工具手写合同为 **1 份 inputSchema，两个工具合计 2 份**；各有一个普通 binding。共用的 Plan Schema 沿用 Batch 12 的 Status/Task/Phase/Plan 四个构造，不另写业务参数 interface 或校验规则。`RefValue` 是一个共用的短试件 helper，不是新增 SDK 公共导出；位置和名称尚未批准。[作者原件](review-evidence/minimal-core-batch-14/samples/author.ts) · [实际 helper](review-evidence/minimal-core-batch-14/samples/ref-value.ts)

## 三文件副本各承担什么

1. SDK `typebox-schema.ts`：只对明确的 Ref 字符串识别 TypeBox 的静态值见证，并将值 Schema 当 Schema 捕获。getter、隐藏行为、预算和其他不支持词汇仍拒绝。
2. SDK `view-type-tool.ts`：现有定义入口显式选择本试件的编译分支；声明仍复用原 definition、ToolSet、目录和类型推导。
3. Runtime `ordinary-parameter-contract.ts`：在既有 normalizer / fieldIssue 中复用对象规则并递归检查 Ref payload 的对象、数组和标量约束，没有引入第二套引擎、依赖、缓存或注册中心。普通字段的有限 profile 保持。

原编译器的首次失败已在修改前保存：SDK 在 `$.properties.target.~unsafe` 拒绝；最小嵌套对象在 `$.properties.target.properties` 被 Core 拒绝；完整 Plan 在 `$.properties.phases.items.required` 被拒绝。[最小输入与原返回](review-evidence/minimal-core-batch-14/results/baseline/first-failures.json)

为覆盖 Plan 必需结构，副本只在 Ref 注解的值 Schema 中扩展了原有递归检查。默认 `compileOrdinarySchema(schema)` 仍拒绝新注解；声明试件必须显式选择临时 `ref-value-specimen`。它提供两个明确方法：`validateModelInput` 检查名字形式，`validateResolvedInput` 检查已取得的值。原 `validate` 对这种新合同固定拒绝。因此现有普通入口既不会自动升级，也不会把 Ref 当普通字符串交给业务。

**声明层面存在临时 API 差异，未掩盖：** Core 编译函数多一个可选试件选择参数，合同类型增加两个验证方法和一个临时身份标签。六份声明原件实际保存，其中五份字节相同，Core 参数合同声明一份变化。没有改公共导出清单、包版本、依赖或 Worker 协议。[声明对照](review-evidence/minimal-core-batch-14/declaration-proof.json)

## 四个可观察结果

| 要求 | 实际结果 |
| --- | --- |
| 单对象与列表声明可运行 | 两个 SDK 定义真实构造成功；严格类型正例通过，五项类型反例按预期拒绝；两个 Ref 字段均输出名字字符串 |
| JSON 跨进程、形状和身份 | writer/reader PID 不同。reader 不导入 TypeBox、作者模块或 helper，仅从 JSON 与 Core 编译器取得 object / array 形状及约束。sender 与 reader 的完整 fingerprint 一致；同一参数名的 Plan / Plan 列表 / Phase 合同身份全部不同 |
| 真实值及结构/预算拒绝 | 从封存实际发布记录取得 Plan、列表、元素，三者按对应合同通过；空列表也通过。只有 title 的历史占位对象、对象/列表错配、非法阶段/任务状态，以及字节/节点/深度超限均拒绝，共保存 13 条完整输入与结果 |
| 原包与未实现入口拒绝 | 原包 SDK、Core 编译器、真实 Core registry 对候选最终 JSON 均拒绝。候选 registry 的普通入口也拒绝，不依赖“受信工厂会自行校验”的假设：工厂 0、handler 0，拒绝发生在注册编译阶段 |

完整产物见 [声明 JSON](review-evidence/minimal-core-batch-14/results/candidate/declarations.json)、[独立进程结果](review-evidence/minimal-core-batch-14/results/candidate/reader-results.json)、[原包原返回](review-evidence/minimal-core-batch-14/results/baseline/old-rejection.json)。普通字段/default、不支持 pattern、schema getter 0 次读取，以及声明字节超限见 [边界结果](review-evidence/minimal-core-batch-14/results/candidate/edge-results.json)。

## 值来源、上限与责任边界

输入锁定于 Batch 12 原快照的 `publication.target.payload`（对象、数组、元素），以及 Batch 13 首版真实 Driver/Worker 交给 handler 的 title-only 对象。每份来源保留文件 SHA、JSON Pointer、snapshotId 和原 owner 信息。[来源原件](review-evidence/minimal-core-batch-14/captured-values.json) 不是新的 Ref resolver，不代表这些历史名字现在还有读取资格。

保留声明 **24 层 / 5,000 节点 / 64 KiB** 与输入 **24 层 / 10,000 节点 / 128 KiB** 的原上限。专属样例实测声明字节超限和三种输入超限；普通合同原回归继续覆盖其既有边界。没有增加预算或回收服务。

**结构校验通过不等于执行资格。** 本批没有根据名字查 SnapshotStore，没有放宽 App/View/Ref 来源、Scope、观察切换、lease 或授权。当前在线 snapshot-value-v2 路径仍不支持整数组参数；本试件的数组结构校验成功不能改写那项事实。作者 binding 的业务类型已验证，但没有通过一个新的在线执行器进入业务；不把本批写成完整 Ref Tool 接入成功。

## 基线与验证

- 任务书 SHA-256：`fbf4fa24a6abbabad86c2f34d755b7f25d586587b94c79e37ef01f0bb892662e`。使用 Batch 12 已封存的 SRT SDK **0.4.0-srt01-m4.2** / Runtime **3.0.0** 的 294 份实际输入，不以当前 SRT HEAD 替代签收包。业务类型和 Schema 均取 Batch 12 Revision 1 原件。
- baseline/candidate 两组从源码新构建；Node v24.15.0、TypeScript 5.9.3、TypeBox 1.4.3、Vitest 3.2.4；复用现存依赖缓存，未升级或联网安装。
- Core 3 文件 **224 项**，基线和候选各通过；SDK 2 文件 **17 项**，候选通过，独立完整复跑也验证基线 17 项。没有新 skip 或改永久测试。
- 独立新目录 **21 步**重放：三文件补丁检查/应用、两组重建、严格类型、实际原包拒绝、JSON 两进程、值与预算检查、基线/候选回归、反向恢复均符合预期。原包 writer 退出 1、类型反例退出 2 为预期拒绝，不计作通过。13 条值结果及完整合同身份与首轮一致。
- 补丁正向仅改变白名单三个副本，反向恢复全部 294 份冻结输入；whitespace 通过。开工 9,102 个既有文件、旧证据和主树 HEAD/index 保持。两个共享 Planning 页面仍等于开工字节，本执行者未应用 Batch 13；若负责人后续另行应用，不归本批贡献。

候选 [MINIMAL_CORE_BATCH_14.patch](MINIMAL_CORE_BATCH_14.patch) SHA-256：

`386da95b51511428fa318b22719cf22176b370f95aabcb23019dfe63394388ee`

## 留给负责人的最小决定

1. 是否把本试件的 `RefValue` 及完整值 Schema 注解作为正式作者合同；临时关键字、编译选择参数、方法名和 revision 均未签署。
2. 是否正式接受当前有限的递归对象/数组词汇及其约束/预算；本批不支持任意 JSON Schema、Codec、pattern 或联合类型，不静默忽略未知约束。
3. 后续在哪个正式合同中完成已授权快照值的解析及交付，并怎样让 Worker/宿主识别该合同。跨 View、数组 Ref 在线消费、观察采纳和握手不在本批实施。

没有必须扩大本批白名单的阻断，也没有将结构校验之外的缺口算作已贯通。报告、原始失败、完整声明、命令及复跑方法见 [证据索引](review-evidence/minimal-core-batch-14/README.zh-CN.md)。状态仅为 READY_FOR_REVIEW，不自行批准，不提交或发布。
