# Batch 16 · 数组发布的业务种类沿注册路径进入快照

**READY_FOR_REVIEW。** 在冻结输入＋签收 B14/B15 补丁构建的私有包中复现了 unknown 问题，并完成六文件最小候选。作者仍只写已有的 `itemType:'Plan'`；列表和元素均发布为 Plan，名字不变，已有只读 Worker 工具能够验证这个标注。本批没有接入 B15 多引用工具或改授权/Worker 协议。

## 基线事实与丢失位置

原 SDK 的 useArrayRef 把 itemType 用于格式化名字，却以 `registerRef(id,value)` 注册。View 不转发类型，AppKernel 原记录仅保存 value；DOM Producer 又固定输出 `refType:'unknown'`。

负责人原探针未经改写，在本批 B15 组合基线上重新执行：不限种类的元素读取成功一次，要求 Plan 的同一元素在派发前返回 `REF_TYPE_MISMATCH`、业务零次。随后在自己的完整生命周期夹具中，严格编译成功后，按正确类型运行的断言也得到有效红灯：`unknown !== Plan`。[负责人探针本次重跑](review-evidence/minimal-core-batch-16/results/baseline-owner-probe/) · [红灯原输出](review-evidence/minimal-core-batch-16/logs/red-published-plan-kind.stderr)

冻结原包和 B14/B15 组合包也分别运行同一个完整 Worker 夹具，页面、种类、完整数据、收据结果和 handler 输入的语义记录相同，证明参数试件补丁没有先改变这个发布行为。[原包](review-evidence/minimal-core-batch-16/results/original-trace.json) · [组合基线](review-evidence/minimal-core-batch-16/results/baseline-trace.json)

## 六处候选改动和必要职责

1. SDK useArrayRef 在原两处注册调用中传入 itemType，原名字生成、更新、失败回滚和 cleanup 逻辑保持。
2. SDK View 的原注册闭包转发可选的 refType。
3. 原 IRefRegistry / IRefExporter 两个 SPI 的既有 registerRef 签名增加可选字符串参数，不引入新方法或选项管理器。
4. AppKernel 把种类存进原 refRegistry 的同一 Entry，并随 getViewRefs 返回。update 仍只更新值；释放仍按原 Entry 身份保护所有者，未建立第二个 Map。
5. DOM Producer 读取该字段。只有明确的非空白字符串成为 refType；其余继续 unknown。非空白类型保留原字符串，判断用的 trim 不会改名字或类型值。

沿用链路为 **useArrayRef → View → 原注册端口/AppKernel Entry → DOM Producer → Snapshot/Observation → 原只读工具**。没有从名字前缀或数据字段推断种类；没有新注册中心、执行路径、授权规则、缓存、资源策略或状态 owner。

[单独 patch](MINIMAL_CORE_BATCH_16.patch) 相对本批实际隔离基线，仅包含任务书六个生产路径；SHA-256：

`63ac303ab8dd1458b5fe802c0fd70c09190778669cf9fe7dde2e2e4776713e21`

## 真实 Worker 的调用与资格证据

主夹具使用封存的真实 PlanListView，另加同形 Order、未标注/假前缀、空串/空白控制数据。消费者使用原 useViewSnapshotTool / snapshot-value-v2 路径。主 Scope 沿用负责人既有的“授予所选 View 内 Ref”策略，选择 root/plan_list；private_data View 的真实 Ref 没有授予。所有下列调用来自同一个初始有效观察，不通过 App 手查引用或伪造 payload。

| 调用 | 候选事实 |
| --- | --- |
| 要求 Plan，读取 `Plan:unfinished_plans[0]` | `succeeded / entered-returned`，执行授权一次、业务一次，收到完整只读 plan_a |
| 要求 Plan，读取同形的 `Order:orders[0]` | `REF_TYPE_MISMATCH / not-dispatched`，授权与业务均零 |
| 要求 Plan，读取未标注的 `Plan:pretend[0]` | `REF_TYPE_MISMATCH`，零业务；不相信前缀 |
| 要求 Plan，读取真实但未授予的 `Plan:private_plans[0]` | `REF_NOT_VISIBLE`，零业务 |
| 不限种类，分别读计划、Order、假前缀元素 | 各成功进入一次，收到相同结构的 plan_a，证明对照数据可读 |
| 要求 Plan，读 `Plan[]:unfinished_plans` | 类型匹配后由原对象入口返回 `REF_VALUE_UNSUPPORTED`，零业务 |
| 不限种类，读整份列表 | 仍是 `REF_VALUE_UNSUPPORTED`，零业务 |
| 要求 Plan，读原单对象 `active_plan` | 仍因 unknown 被拒绝；未新增单对象作者接口或猜测类型 |

候选中 Plan、Order 和假前缀三份完整 target payload 实际相等，只是元数据分别为 Plan、Order、unknown。收据、观察、绑定、授权上下文、handler 输入和递归冻结断言均保存完整原件。[候选真实轨迹](review-evidence/minimal-core-batch-16/results/candidate-trace.json) · [完整复跑核对](review-evidence/minimal-core-batch-16/reproduction-proof.json)

基线中，受限整列表调用先因 unknown 返回 `REF_TYPE_MISMATCH`；候选正确传递 Plan 后抵达原数组形状拒绝。这是明确的阶段变化，不意味着现有对象入口已支持整列表业务。

## Agent 实际看到什么

默认 SemanticAOTUIDrivenSource 真实构建每一阶段的消息，临时 Context 均释放；没有改 Source 代码或呈现策略。主 Scope 的授权观察另外完整保存，默认 Source 预览不是用来模拟这些授权。

页面正文、Ref 名字和数据内容与基线逐字/逐字段相同。变化限于默认 Source 的 Available references 提示：

```diff
- Plan[]:unfinished_plans (unknown), Plan:unfinished_plans[0] (unknown)
+ Plan[]:unfinished_plans (Plan), Plan:unfinished_plans[0] (Plan)
```

Order 控制数据相应标为 Order；假前缀和无标注数据仍是 unknown。列表与元素使用同一业务种类，差别由现有目标值的数组/对象形状表达。上述摘录只展示相关片段，完整消息、其他引用及五阶段实际 diff 均保留。[实际提示 diff](review-evidence/minimal-core-batch-16/agent-visible-diff.md) · [完整页面和消息比较](review-evidence/minimal-core-batch-16/comparison.json)

没有调用真实模型，所以不把提示变化解释为已证明 Agent 任务成功率变化。

## 更新、清理与无标注边界

真实 Worker 连续执行 initial → updated → short → empty → unmounted：

- 同名 `Plan:unfinished_plans[0]` 更新到新标题，接收者拿到的完整值与本轮快照一致，不只比较 id。
- 缩短后索引 1 退出新观察，强行调用返回 `REF_NOT_VISIBLE`；空列表时索引 0 也退出。
- 空列表本身仍注册、仍为 Plan；原对象工具仍拒绝其数组形状。
- 卸载后 plan_list View、其全部 Ref 与两个只读工具退出新观察。
- 观察显式 release，Context release，Scope close，最后 Runtime 关闭。实际关闭回执为 resourcesReleased=true，retainedScopes/retainedBytes=0，Worker pool total/leased=0，没有关闭失败。

无标注、`itemType:''`、`itemType:'  '` 的开工表现各自采样。候选保留 raw 名字：`plain[0]`、`empty_label[0]`、`  :spaces[0]`；列表名也保留，空白不 trim。它们继续投影为 unknown，页面没有因空白 refType 失去投影。业务种类的正式合法值和空白策略仍待上级定稿，此候选保持这些既有可观察行为。

复跑使用封存页面，未套用 Batch 13 的页面修复。empty 阶段该旧页面仍发布历史 active_plan 占位，类型保持 unknown；本批没有把它改写为 Plan 或宣称修复单对象发布。共享 Batch 13 两页完全未动。

## 声明差异必须单独决定

**存在真实 SPI 类型签名变化，不能写成 API 完全不变。** 两个既有注册方法分别增加可选第三/第四参数，AppKernel/DomSnapshotSource 的 getViewRefs 行增加可选字段。它们只在隔离候选中实施，正式采用、版本与集成约束交上级裁决。

实际审计全部 **143 对声明**，变化五个文件：

- SDK hooks/useArrayRef：只增加现有 itemType 的说明，作者签名和 options 字段不变。
- Runtime spi/app/public-types、spi/app/ref-exporter.interface：可选 refType 参数。
- Runtime worker-runtime/app-kernel/AppKernel、worker-runtime/dom-snapshot-producer：相应注册/记录签名。

五份变化与六个稳定公共入口/组件位置分别保存基线、候选，共 **22 份真实声明原件**。没有新增公共导出名、useDataRef 选项、协议 revision 或包版本。所有 143 对重建声明的指纹在新目录复跑时再次核对。[声明原件](review-evidence/minimal-core-batch-16/declarations/) · [完整声明审计](review-evidence/minimal-core-batch-16/declaration-proof.json) · [真实差异](review-evidence/minimal-core-batch-16/declaration-changes.patch)

## 验证、基线与失败记录

- 任务书 SHA-256 `63ee601ddd7d6dc69701b2c9e4e9eec290f5dfe3c4d5f1e983c794df2da0d3ea`。使用封存 294 份实际输入、签收 B14 累计 patch 与 B15 Revision 1 累计 patch 建立独立 baseline/candidate，不以 HEAD 代替行为基线。[开工记录](review-evidence/minimal-core-batch-16/baseline.json)
- 保护开工 **9,731 个既有文件**和负责人开工 **4 份证据**，原件未重写或算成本批新增；共享源码、SRT 294 输入、HEAD/index 和 Batch 13 两页保持。[保护核对](review-evidence/minimal-core-batch-16/protection.json)
- 实际依赖 Node v24.15.0、TypeScript 5.9.3、TypeBox 1.4.3、Vitest 3.2.4，复用现有缓存，未安装/升级。包仍为 SRT SDK 0.4.0-srt01-m4.2 / Runtime 3.0.0。[环境和解析指纹](review-evidence/minimal-core-batch-16/environment.json)
- 新目录 **35 步**重放：三组构建、严格语义编译（strict=true，skipLibCheck=false）、实际 Worker 五阶段、有效红灯、原 SDK/Runtime 回归与正反 patch。红灯预期退出 1，其他 34 步退出 0。三版本各 **SDK 2 文件 8 项、Runtime 7 文件 125 项**通过；包含重复 owner、旧 cleanup、数组注册回滚、DOM Producer、元数据边界、Ref 参数/绑定/Scope 检查。[完整命令和输出](review-evidence/minimal-core-batch-16/results/reproduction/commands.json)
- 单独 patch 正向仅六个白名单路径；反向恢复 B15 的全部 294 输入，再依次反向 B15/B14 恢复冻结原包。whitespace 通过。[门禁](review-evidence/minimal-core-batch-16/patch-proof.json)

一键复跑，在项目根目录：

```sh
python3 review-evidence/minimal-core-batch-16/reproduce.py
```

它只创建新临时目录，打印位置，不回写历史证据。第一轮与复跑的完整业务字段、收据 outcome、执行阶段、handler 值和次数均核对；保留原始随机 Source/Observation/Binding 身份和时间，没有把独立进程的随机 ID 或桌面日志时间伪装成相等。

中间失败如实保留：夹具初次误用退出的 useViewTypeTool，继而误运行其输出导致安装失败；更正为现有 AppTools 后严格编译通过。随后修正了 observation View 的 id 字段；SDK DOM 测试初次缺少环境，补显式 happy-dom 后原测试通过；首次跨运行比较误含桌面日志实时时间，改为明确列出非等价时钟字段，原日志完整保留。它们都不计为产品红灯，没有删断言或增加 skip。[失败与归因](review-evidence/minimal-core-batch-16/intermediate-failures.json)

## 未实施与待裁决

本批止于已有数组标注的传递和既有消费者验证。正式 SPI/API、种类字面值/提示表述、混用包版本的确认、单对象作者接口、B15 普通工具接入与 Worker 协商仍需上级决定。没有扩展跨 View 寻址、观察采用、资源策略、业务 Schema 验证或自动重试；没有共享应用落地、提交、push、merge、发布或最终 Semantic 验收。状态仅为 READY_FOR_REVIEW。
