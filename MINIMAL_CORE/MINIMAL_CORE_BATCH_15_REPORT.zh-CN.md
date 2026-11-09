# Batch 15 · 同一工具的引用组合合同试件

**READY_FOR_REVIEW。** 一份普通工具参数声明已覆盖单对象名字、整份列表名字、逐项对象名字、三种可省略引用及普通备注。严格类型、跨进程 JSON、整组结构校验、展开后总预算及旧入口拒绝均已验证。实施仅在隔离副本，没有接通在线解析、授权或 Worker。

## 作者声明与三个阶段

主要工具 `compare_plans` 只手写 **一份 inputSchema**。沿用签收的 `RefValue('Plan', Plan)` 与 TypeBox 原生 Array / Optional，没有再写一份业务参数 interface、参数表或校验器：

```ts
Type.Object({
  current: RefValue('Plan', Plan),
  comparison: RefValue('Plan', Type.Array(Plan)),
  selection: Type.Array(RefValue('Plan', Plan), { minItems: 1, maxItems: 3 }),
  maybeCurrent: Type.Optional(RefValue('Plan', Plan)),
  maybeComparison: Type.Optional(RefValue('Plan', Type.Array(Plan))),
  maybeSelection: Type.Optional(Type.Array(RefValue('Plan', Plan), { maxItems: 3 })),
  note: Type.String({ default: 'not inserted' }),
}, { additionalProperties: false });
```

[作者原件](review-evidence/minimal-core-batch-15/samples/author.ts) · [严格只读业务函数](review-evidence/minimal-core-batch-15/samples/business.ts)。实际 binding 的参数类型从该声明推导，再传给消费真实只读 Planning 类型的函数。Ref helper 直接复用 Batch 14 Revision 1，字节未改；Plan Schema 和业务类型取签收的 Batch 12 原件。

| 字段 | 模型输入 | 就绪业务值 |
| --- | --- | --- |
| current | `active_plan` | 只读 Plan |
| comparison | `Plan[]:unfinished_plans`，一个名字 | 只读 Plan[] |
| selection | `["Plan:unfinished_plans[0]", "Plan:unfinished_plans[1]"]` | 逐项 Plan 组成的只读数组 |
| 三个 maybe 字段 | 没有提供，或各自合法形式 | 没有该属性，或对应值 |
| note | `active_plan`，普通字符串 | 原样的 `active_plan` |

一个完整阳性样例的直接业务输出为：

```json
{"current":"plan_a","comparison":["plan_a","plan_b"],"selection":["plan_a","plan_b"],"note":"active_plan"}
```

[完整模型参数与业务参数原件](review-evidence/minimal-core-batch-15/input-examples.json) 同时标记执行资格未提供。`validateModelInput` 只检查名字形式，所以非空的未捕获名字也能通过语法检查；这不证明名字存在、可见或可执行。`validateResolvedInput` 只检查已经取得的整组值。本批没有名字查表或授权实现，历史数据由夹具显式供给；不把这一步描述成生产 resolver。

## 最小实现及首次失败

基线由冻结的 SRT 实际 294 份输入加上签收的 Batch 14 累计 patch 构造。未改生产前，主样例严格编译成功，但 SDK 定义在 `$.properties.maybeSelection.items.minLength` 返回 `TOOL_SCHEMA_UNSUPPORTED`。最小逐项引用输入在 SDK 与 Core 都定位到 `$.properties.target.items.minLength`。[原输入与原返回](review-evidence/minimal-core-batch-15/results/baseline/first-failures.json)

实际只修改一个已授权 Core 副本文件 `runtime/src/core/tool/ordinary-parameter-contract.ts`：

1. 数组项明确带 Ref metadata 时，复用原 `normalizeField`；没有 Ref 的普通数组仍按原有限词汇检查。
2. 原 `fieldIssue` 根据现有“模型形式 / 就绪值”标志，选择名字 Schema 或值 Schema。直接字段与数组项共用同一段选择和递归规则，没有分别建立处理器。
3. 删除试件“只能有一个且必填的 Ref”限制。必填/可选继续由原 required 集合判断；只需知道是否含 Ref，原 filter 收敛为 some。即使仅有 optional Ref 且本次全部缺省，普通 `validate` 入口仍拒绝，不能降级。

两个 SDK 副本文件均未产生本批差异。没有新公共类型、导出、依赖、策略、状态、注册中心、队列或解析器。整组捕获、预算、diagnostics 上限、冻结输出及失败结果不带 value 的责任仍由已有 check/bounded 承担。

独立 [MINIMAL_CORE_BATCH_15.patch](MINIMAL_CORE_BATCH_15.patch) 相对于本批隔离基线，只含一个生产路径；SHA-256：

`7089b7c13cfd00556bb811e8b6eedb523051846246d0648b33259ac83399ff07`

## JSON、身份、整组失败和预算

writer 经过真实 SDK 入口导出完整 JSON，另一个 Node 进程只导入 Core 与一个无 TypeBox/作者模块运行时依赖的纯业务函数。字段语义由声明中的直接 `x-aotui-ref-value` 或数组项的 Ref metadata 决定，Core 的 normalizeField / fieldIssue 承担解释，不从名字前缀或业务数据形状猜测。[完整声明](review-evidence/minimal-core-batch-15/results/candidate/declarations.json) · [独立读取原结果](review-evidence/minimal-core-batch-15/results/candidate/reader-results.json)

身份夹具固定同一个工具、同一个 `target` 字段和说明，构造八种声明对照：对象/列表/逐项名字，分别必填与可选，另有同形不同业务种类、不同数量约束。八个完整 fingerprint 均不同，且与独立 reader 重建值一致。这些是声明对照夹具，没有新增八种工具类别，也未注册执行业务。

组合验证保存 **53 条完整输入与结果：14 条成功、39 条拒绝**。覆盖三个可选形状全部缺省、全部合法、提供错误值或 null、必填缺失、对象/列表混淆、数组某一项不合法、嵌套状态错误、空名字、数量边界、额外字段与普通空备注。optional 没提供时不插入属性；提供错误值时整组失败。失败结果没有部分 value。备注恰好等于引用名仍原样传递；required note 的 default 注解不填补缺省。

结构阳性中实际直接调用严格编译的业务函数 **7 次**，读到了对应计划 ID。该直接消费探针没有经过 Runtime 调度或 Worker，不能作为授权门禁已贯通的证据。旧注册入口验证是另一条真实边界：冻结旧包、Batch 14 基线以及候选的普通 registry 均在工厂前拒绝，factory/handler 都为 0。[冻结旧包](review-evidence/minimal-core-batch-15/results/original/old-rejection.json) · [B14 基线](review-evidence/minimal-core-batch-15/results/baseline/old-rejection.json)

原输入总预算仍为 **24 层 / 10,000 节点 / 128 KiB**，声明仍为 **24 层 / 5,000 节点 / 64 KiB**。同一 70 KiB 标题计划放在 current 或 maybeCurrent 中单独测试，整组 JSON 分别为 **72,508 / 72,701 字节**，都通过；同一个对象同时放进两个字段时为 **144,350 字节**，在整组捕获阶段拒绝，没有直接调用业务函数。名字参数本身很小也不能豁免展开后预算。输入中确实复用同一个 JS 对象，copyJson 按两处出现分别计费；没有额度上调或缓存绕过。

样本来自已封存的真实计划、整份列表及其元素；第二个元素值取实际列表第 1 项，名字取真实 observation refs 第 3 项，不是猜造名字。完整指纹、JSON Pointer 与原始来源保存在 [capture-inputs.json](review-evidence/minimal-core-batch-15/capture-inputs.json)。实际发布标签仍是 `unknown`，本批未改成 Plan，也没有凭结构推导执行资格。

## 基线、验证和证据

- 任务书 SHA-256：`5875b2dbbe5e225b66c6187988917732f15d6bc1f56e6bc413b1684bcdf720e1`；B14 签收补丁 `67a26f…d35d70`、清单 `371c049f…c0c64b` 的实际原件及全部产物已核对。
- 开工实际工作树保护 **9,383 个既有文件**、HEAD/index 与 SRT 294 个冻结源码输入。核对时全部保持，没有应用或修改 Batch 13 两页；无本批外的源码差异。[实际基线](review-evidence/minimal-core-batch-15/baseline.json) · [保护核对](review-evidence/minimal-core-batch-15/protection.json)
- 真实依赖为 Node v24.15.0、pnpm 10.15.1、TypeScript 5.9.3、TypeBox 1.4.3、Vitest 3.2.4，SDK 0.4.0-srt01-m4.2 / Runtime 3.0.0。复用现有缓存，没有安装、升级或修改锁文件。[解析路径](review-evidence/minimal-core-batch-15/environment.json)
- 从新目录独立复跑 **44 步**：三组新构建、基线首次拒绝、新作者严格类型与 8 项预期类型拒绝、跨进程 JSON、组合与边界、旧入口拒绝、B14 完整回归、正反补丁。原包、B14 基线、B15 候选分别 **Core 224 项、SDK 17 项通过**，没有修改永久测试或新增 skip。[完整命令/目录/退出码/输出](review-evidence/minimal-core-batch-15/results/reproduction/commands.json)
- B14 的严格类型正例、5 项类型反例、单对象/列表 13 条完整数据结果、六种同形业务声明的完整身份、静态见证/getter/名字边界及普通数组计数继续保留。基线与候选完整输出仅有实际进程 PID 不同；未归一化业务字段。[完整比较](review-evidence/minimal-core-batch-15/comparison.json)
- 六个 SDK/Core 声明位置分别保存原包、B14 基线、B15 候选的 **18 份真实原件**；基线到候选六份字节全部相同。原包的一份 Core 临时差异来自已签收 B14，不是本批新增；作者与业务函数声明也实际保存。新目录重建的 18 份再次匹配。[声明原件](review-evidence/minimal-core-batch-15/declarations/) · [审计](review-evidence/minimal-core-batch-15/declaration-proof.json)
- 单文件 patch 正向仅改目标 Core；反向恢复 B14 的全部 294 份输入；再反向 B14 patch 恢复冻结原包 294 份。whitespace 检查通过。[patch 门禁](review-evidence/minimal-core-batch-15/patch-proof.json)

可重复命令，在项目根目录执行：

```sh
python3 review-evidence/minimal-core-batch-15/reproduce.py
```

该命令只创建新的临时目录，输出其路径，不回写旧证据。

一项中间探针失败已保留：首次断言误以为数组项先拒绝 Ref 关键字，实际旧词汇先拒绝 minLength。修正为真实路径后，在未改生产的相同基线上重跑通过；没有用导入/类型失败冒充合同失败。[原失败与归因](review-evidence/minimal-core-batch-15/intermediate-failures.json)

## 仍需上级决定

1. Ref helper、序列化关键字与有限 Schema 词汇的正式作者 API，以及单列表与逐项引用的定稿表述。
2. 模型名字与已取得值之间的正式 Core/Worker 准备合同：来源身份、可见性、逐项失败、授权参数与实际执行的一致性。当前 `unknown` 发布标签如何迁移需要明确，不能靠本试件补猜。
3. 新协议/profile 与旧入口的确认方式、应用迁移及最终包验证；本批的旧入口拒绝不替代 Worker 协商。

本批没有执行真实模型、在线 Ref 解析、Scope/Observation/lease 资格链、Worker、共享应用迁移或最终 Semantic 验收。未新增跨 View 寻址、业务重试或发布行为。状态停在 READY_FOR_REVIEW，等待负责人独立复核。
