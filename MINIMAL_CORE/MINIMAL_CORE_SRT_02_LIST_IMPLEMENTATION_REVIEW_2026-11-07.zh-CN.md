# SRT-02 单个必填对象列表 Ref：独立实现裁决

2026-11-07。**APPROVED，限定为本次精确隔离候选的实现与运行合同。** 普通 ViewType Tool 已能接收一个必填对象列表 Ref，并保留原来的单对象 Ref。SRT-02 整体仍未收口；本裁决不批准共享采用、常规包安装、发布、真实模型或最终 Semantic 验收。

## 交付身份与复核方法

实施由 SRT Owner 完成，Minimal Core 负责人独立复核并执行必要复验，两方没有并行修改同一生产文件。

| 交付 | SHA-256 |
| --- | --- |
| final-submission.json，290 件原始证据 | `15d0df3438e4339ef5871cd03da414af5d85aa93e773705d1c971c595b641372` |
| 实施报告 | `42f5f0ba793b7f527dfb588f7af84a8d01a15dd20b68fc05ba1535044151e8e5` |
| 六文件 patch | `177720424ee236f5374722f82fa3ce691366c3f0a6689317e4ddce2d09b17fca` |
| SDK 候选 tar | `43259156c661f0e5b83b2e0fea0040c4ae46bb110bd7be88158de1ca3249be84` |
| Runtime 候选 tar | `3a3a5832a85f3acd997849b28b34f305c5ab1cf3f11115f5c2d6072422f54a7c` |
| 包元数据增补索引 | `b7034936ae3179fcca2600b7d9f097fe34a85f417ec0bb21c9bc65fd2e889ec4` |

负责人逐件核对 290 件证据及增补，重放 patch 后的 **418 件源码／配置**与实际候选一致；SDK 90／Runtime 388 件包文件逐字对应源码或 dist。四组合实际安装文件合计 **1,912 件**。入口首次运行与夹具修订分别审查，原始失败未被覆盖。[实施报告](../review-evidence/srt-02-list-ref-candidate-20261107/REPORT.zh-CN.md) · [交付独立核对](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/final-delivery-check.json) · [独立 patch 重放](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/patch-reconstruction.json)

## 改了什么，职责由谁承担

生产逻辑改动只有两处：

1. [ordinary-parameter-contract.ts](../.tmp/srt-02-list-ref-candidate-20261107/source/runtime/src/core/tool/ordinary-parameter-contract.ts) 第 185 行附近，正式参数合同接受一个必填顶层 `Array<Object>` Ref。多 Ref、可选 Ref、Ref 名数组、非对象列表及列表套列表继续拒绝。
2. [snapshot-value-arguments.ts](../.tmp/srt-02-list-ref-candidate-20261107/source/runtime/src/core/tool/snapshot-value-arguments.ts) 第 88 行附近，按声明区分单对象与对象列表；原 Observation、可见授权、显式类型、对象结构、总预算和 lease 清理沿已有代码完成。

其余四文件是 SDK helper 注释、README、参数文档和历史容量测试夹具。没有新增公开签名、Hook、解析器、状态管理器、wire 或 capability。SDK `useArrayRef` 已拥有发布职责，无需另建列表发布体系；Runtime 已有的参数准备与调用链负责解析、验证和释放；App 继续校验当前业务对象、归属、状态与权限。文件工具继续直接使用路径。

页面可显示 `[任务列表](Task[]:tasks)`，模型传完整名称，handler 收到该次观察中的只读对象数组。单项仍用 `Task:tasks[0]`，显式 metadata 类型均为 `Task`，由声明区分列表与单项。作者复用同一份声明和普通 Tool，不需要自行解析名字、逐条复制内部 ID 或为列表创建另一种 Tool。

本批解除两处仅允许单对象的执行限制，是统一参数消费的前置增量；**尚未删除旧 Snapshot Tool 模块**。后续清理必须迁移真实消费者再删除，不能把本批能力增加写成旧路径已经退出。

## 实际验证

| 验证层 | 结果与独立依据 |
| --- | --- |
| 四种 SDK／Runtime 组合 | 负责人核对全部声明注册原件与运行结果。四组标量各 6 调用；新 Runtime 两组各 16 列表调用。合计 **56 调用、22 次派发并进入业务、34 次派发前拒绝**；进入业务的 22 次包含 2 次 App 明确拒绝。旧 Runtime 在真实 SDK commit→Core 注册时拒绝列表，未静默回退。 |
| 新列表真实 Worker | 负责人在自己的全新目录独立重跑 **16 调用**：6 成功、9 框架拒绝、1 App 业务失败。授权、raw/effective、V4、handler 值和来源逐一一致；合法调用进入一次，错误输入不进入业务。短收据与最新 View 分离。 |
| Core 与容量 | 负责人独立重跑 **28 项**，包含形状、原观察、授权等待期间撤销、不可变数组／元素、整体字节与节点边界、超额及释放。总预算没有按元素重置。 |
| 普通 TS 与 Preact | 负责人独立复验真实 SDK binding→Core 注册／调用；整体与两个元素共 **3 个 Ref**的名称、metadata、payload 相同，普通 TS 真实业务进入一次。 |
| Worker 适配器 | 负责人以实际捕获的 V4 请求独立复验 **9 种变异拒绝**；此项是适配器校验，未冒称额外真实 Worker 调用。 |
| 公开类型 | 负责人在精确包的新消费者中独立执行 **TS 5.3.3 和 5.9.3**，strict、exactOptionalPropertyTypes、skipLibCheck:false。handler 字符串误用、数组追加／槽位替换／元素写入等预期错误得到验证。 |
| 既有回归 | 实施者 SDK **91 项**、Runtime 精选 **273 项**通过；负责人核对输入、实际退出及原始日志，未把这些数字写成负责人全部重跑。 |

负责人复验目录为 `.tmp/srt-02-list-ref-owner-review-20261107`，与执行者生产目录和结果隔离。原始输出、业务 JSONL、关闭回执及 24 件验证输入已另行封存。[结果核对脚本](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/verify-results.py) · [结果](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/results-check.json) · [独立运行命令与输出](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/independent-runs) · [独立输入归档](../review-evidence/srt-02-list-ref-candidate-20261107/owner-review/independent-validation-inputs.tar.gz)

原始失败均保留：SDK capture／正式注册阶段混淆、Core 夹具缺少 now、四项历史容量夹具、首个列表收据对象原型比较。四项容量失败在未改 B23 同样复现；仅把夹具切到实际正式 profile 后通过，±1 边界和释放断言没有删除。收据修订仅比较结构化复制后的相同键值，首轮实际业务和关闭事实保留。它们不能计为产品成功，也没有被用作扩大生产改动的理由。

## 未覆盖风险与采用边界

- **旧观察生命周期尚未收敛。** 本批证明 O1/O2 按各自原观察解析、显式 release 后拒绝。释放 Context/Source 时临时持有和 activeLeases 为零，Store 仍有 1 个当前、5 个历史快照，分别 7508／37612 字节。真实 Runtime shutdown 的受管资源、交互持有和 Worker 池随后结算为零。SRT-05 的自动观察交接、旧 Ref 立即失效及旧 payload 释放未完成；没有 GC／RSS 承诺。
- **分发与普通安装没有验证。** 终审独立发现两包 manifest 相对基线 tar 恢复了源码中的 `prepublishOnly` 和 `pnpm.overrides`，含 workspace `link:` 路径；执行者以增补保留披露，原报告未改写。24 个语义叶字段已逐项核对，其他语义字段不变，没有新增 install/prepare/postinstall。当前是离线 pack、精确解包及显式依赖链接后的执行证明。正式采用前须审查元数据并验证真实包管理器消费。[元数据增补](../review-evidence/srt-02-list-ref-candidate-20261107/PACKAGE_METADATA_ADDENDUM.zh-CN.md)
- **功能范围有限。** 多 Ref、可选 Ref、Ref 名数组仍不支持；真实需求与实施范围须分别审查。旧 Snapshot Tool 仍有消费者。未重新运行无关 Host/Driver 全量测试，未开展真实模型、GUI 新一轮验收或共享集成。
- **既有隔离事故边界继续生效。** MC-HOST-PREVIEW-01 仍 OPEN，第三轮 Host 未准入。用户已接收的 Planning 私有手测环境未操作；本候选批准不解除该限制。

共享树已有其他工作，本候选不能按目录整体覆盖。重大公共语义、采用／发布与最终 Semantic 验收继续由上级负责人决定。

## 下一批：先核对可删除职责与真实参数缺口

下一项是**只读收尾范围审查**，不直接开工实现更多 Ref 形状。先利用本批已支持单对象及整列表的事实，核对现有 Snapshot Tool 消费者能否迁入普通 Tool、还差什么、哪些专属职责现在可退出。多必填 Ref 仅在真实消费者或明确承诺需要时进入具体实施建议；不为参数形状对称而扩展 API。

准出条件：逐个列出仍支持的实际消费者与行为；给出调用身份、来源绑定、只读／mutating、授权、普通参数、总预算及清理的保留位置；列出最小迁移／删除文件和必要负向验收；区分当前实现、已批准约束与需要所有者决定的语义。若确需多个必填 Ref，必须先说明累积 effectiveArgs、逐参数来源对应、混合列表／单项、同名或同一 Ref 重用和整体预算的实际边界。包元数据与共享采用准备继续作为独立门禁，不用本次签收代替。

Codex Prompt：

> 你负责 SRT-02 统一消费后的只读收尾范围审查。当前精确列表候选已获限定 APPROVED；不得改共享或隔离生产代码，也不得自行采用、发布或删除旧入口。复用已封存清单并核对实际调用方，逐项说明旧 Snapshot Tool 的真实消费者、当前普通 Tool 能否接替以及必须保留的身份、授权、业务与释放语义。优先提出可删除的重复职责；多必填 Ref 先给真实需求和最小验收，不自动放开可选、多选或 SRT-05。若没有真实多对象消费者，明确记录并提出更有价值的收尾顺序。提交准确源码／包身份、最小文件范围、保留模块、负向测试矩阵、未决语义与下一条可执行 Prompt，状态 SCOPE_READY_FOR_REVIEW；由 Minimal Core 独立复核后再定具体实现范围。你不是唯一执行者，不覆盖他人修改，不触碰用户手测环境，不启动 Host 或模型，不重跑原证据目录。
