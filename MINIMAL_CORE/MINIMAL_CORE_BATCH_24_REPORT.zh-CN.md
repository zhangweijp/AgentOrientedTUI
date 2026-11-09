# Batch 24：Ref 候选采用依赖与剩余能力盘点

状态：**READY_FOR_REVIEW**。本批只有只读诊断和证据交付，没有采用 B22、解决冲突、修改生产源码或重建共享产物。负责人随后下发 B25，要求优先交可手测的隔离 Host；本报告按此调整简洁封存，不继续扩大调查。

## 结论与精确基线

B22 的隔离签收成立，但它不是可覆盖共享 SDK/Runtime 的完整采用包。共享 SDK 使用 `defineViewTypeTool({execute,...})` 和 `useViewTypeTool`；候选继承 SRT M4.3 的静态声明、ToolSet、AppTools 和 controller binding。正式采用需要同时处理作者接口、现有 App、Worker 协议和共享独有修复，不能只复制 B22 的 22 个文件。

冻结 B23 已落地后的实际源码、配置及调用方 600 件、补充消费试件 31 件，保存压缩原件；现有 SDK/Runtime/Driver 构建指纹 460 件。SRT 基线为 `853495dd9954eb4f8a91998bcc59e19326765981`，按 B14 R1、B15 R1、B16、B22 的已签补丁顺序在私有目录重建。每步 check/apply 均退出 0。没有用 HEAD 代替实际共享工作树。

B22 SDK tar SHA：`c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff`；Runtime tar SHA：`0f0896237ec113c65fcd91b4e3697229fd7b647a811eae10f8b4dbb2f4f7573b`。共享 SDK 是 0.3.0；候选是 0.4.0-srt01-m4.3 并增加 `./tools` 子入口。候选 Runtime 沿用 3.0.0，不能靠版本文字判断实现身份。

SRT-01 已按 G3 正式裁决 ENGINEERING_ACCEPTED，固定六个原样本加三个授权替换为 9/9。原批 6/9 历史仍保留；本批未进行模型评测，也不把该裁决视为 B22 共享采用或 SRT-02 全能力完成。正式裁决 SHA `297cec806751d8336e3dec6c7e14cb507d3157e2325fd4608542c6f6831de183` 已封存。

## 差异与应用诊断

| src 路径分类 | 数量 | 含义 |
| --- | ---: | --- |
| 与 B22 候选字节一致 | 217 | 不等于逐项重新验收 |
| 仍是 SRT 原始内容 | 17 | 尚无候选链上的相应变化 |
| 共享与原始、候选均分叉 | 52 | 24 生产、28 测试，需逐职责整合 |
| 共享独有 | 2 | 旧 useViewTypeTool 与 Worker 安装诊断测试 |
| SRT/候选有、共享无 | 4 | AppTools、tools 子入口及两个 SDK 测试 |

合计 292 个路径；SRT/候选各 290，共享 288。原 SRT 路径中共享同时不同于原始和候选的为 56（52 分叉加 4 缺失）。负责人先前的 55 是定位快照，B23 单文件说明应用后重算为 56；这些数字不是缺陷计数。B14–B22 相对 SRT 的 src 路径没有新增或删除，不能把上表的 SRT 既有文件写成 B22 新增。

对隔离共享副本执行 `git apply --no-index --check --whitespace=error-all`：B22 单独退出 1，报六个文件 hunk 不适用；B14 单独、B14/B15/B16 组合和完整四补丁检查也均退出 1，首先在 SDK `view-type-tool.ts:132` 失败。实际顺序尝试在 B14 失败即停止。没有 force、三方合并或合成采用 patch。完整参数、退出码和 stderr 在 `commands.json` / `patch-checks.json`。

必须保留的共享职责：

- B01：`scoped-interaction.ts` 在观察配置验证成功后复用 `observations.limits.source`；唯一 State owner、同步 ledger 占位、逐次读取授权与真实在途结算保持。实际编译 Core 的公开入口探针：共享拒绝前 getter 读取 0 次、固定 TypeError；候选固定基线读取 1 次并透出 sentinel。候选整文件覆盖会回退这项输入边界；这不改变 B22 相对其固定基线的签收结论。
- B02/B04：终态字段只有一份纯规则，Core/Worker 捕获预算各自独立；发送端完整响应只捕获一次，接收端仍独立捕获。候选旧基线里仍有重复规则、二次响应捕获，整文件覆盖会重新带入。
- B08：普通 registration 的 Schema/canonical 镜像已删除，读 definition；SnapshotValueRegistration 的 canonical 及计费、激活和清理仍有职责，不能一并删除。
- WorkerError：共享的有界 cause、生命周期错误详情、安装/关闭链路诊断属于真实行为。相关 manager、worker-host、sandbox、close-handle、messages、worker-runtime 不能用候选旧基线覆盖；共享独有安装错误测试要保留。
- B23：Markdown `[文字](完整Ref名)`、路径与普通 JSON 独立合同的说明已落地，不能恢复旧格式或全局对象转 Ref 规则。
- B09/B10 及 Driver：五 Source 的 getContext、捕获的 executor/receiver、topic 身份、IM 结果通知、逐订阅者异常隔离、模型 SDK 不持 execute 均属于共享链路已有保证。它们不在本次 SDK/Runtime src 数量中，但不能因候选依赖同名 Driver 包而替换掉。

完整逐路径指纹见 `source-matrix.json`；逐文件共享→候选 diff 压缩在 `diagnostic-diffs.tar.gz`，它们是诊断材料，不是获准采用 patch。职责组与配置身份分别见 `integration-responsibilities.json`、`config-matrix.json`。

## SRT-02 能力分层

| 场景 | 发布、静态/编译 | 实际 Core/Worker 证据与缺口 |
| --- | --- | --- |
| 单个对象 Ref | B14/B15 样件与 B22 正式 profile 支持 | B22 已签真实 Worker 成功；数据实际来自 useArrayRef 的一个元素，不能泛称 typed useDataRef 已完成 |
| 数组整体 | B16 贯通 itemType 到整体及元素；specimen 可编译数组载荷 | B22 正式 profile 拒绝数组；preparer 也拒绝非 object。无普通工具数组整体业务进入证据 |
| 数组元素 | B16 发布完整元素名 | B22 的 Plan:plans[0] 已真实执行，仍是一个对象 Ref |
| 多个 Ref | specimen 可编译、校验多字段 | 正式 profile 拒绝 >1；尚无多来源 Worker 执行证据 |
| Ref 数组 | specimen 支持对象 Ref 的选择数组 | 正式 profile 拒绝；B15 R1 还明确拒绝数组元素本身为 list Ref 的声明，不能外推 |
| 可选 Ref | specimen 对缺席/有值均可校验 | 正式 profile 要求必填；无正式 Worker 可选路径证据 |
| 普通附加参数 | 已有普通字段与一种 Ref 可并存 | B22 普通/大附加参数探针已签；B23 文件路径、普通 JSON 实际 Worker/Driver 已签；不强包 Ref |
| 类型不符 | kind 与载荷结构分别验证 | B22 错类型、上传对象、失效 activation 等在业务前拒绝 |
| 解析失败 | 原观察 granted 来源与原 Snapshot 共同约束 | B22 不可见、释放、授权挂起时撤销、错配协议及在途关闭已签；保留旧 A 的 Context 不证明 SRT-05 自动撤销旧观测 |

本批新运行的是实际已编译 Core 的 **32 组纯编译输入**及公开配置 getter 对照，不运行 resolver/grant/Worker/业务。候选 specimen 的八类均接受，但其普通 validate 对 Ref 明确拒绝，不能当作执行合同。正式 profile 只接受单对象、单对象加普通字段及纯普通对象。共享旧函数只有一个参数，JS 传第二个 profile 会被忽略；共享普通对象编译成功不说明支持候选 profile。

上述 Worker、静态作者推导和声明成绩引用 B14–B23 的精确历史材料，本批未重跑或重新计数。机器矩阵明确区分新探针与历史证据。未验证项的最小办法：在正式 profile 扩展获得授权后，逐类贯通发布→原观察来源→授权 effectiveInput→真实 Worker handler，测试错误来源/类型/预算/关闭均无额外业务进入；不能以类型或 specimen 编译代替。

## 作者调用方与退出前置

实际共享的 IDE、Planning、Terminal、Browser 四个 App 仍使用 inline execute/useViewTypeTool；Planning 的 `plan_id/phase_id/task_id` 是业务标识，create_plan 的 phases/tasks 是普通 JSON；IDE 路径、Terminal ID、浏览器 URL 也各有业务合同。发布了 Ref 不等于工具已经消费 Ref。

共享 `useDataRef(refId,data)` 仍是两参数入口，没有已实现的 typed object options；B16 的类型贯通针对 useArrayRef。RefValue 目前是封存样件中的 TypeBox witness helper，没有新增公共 SDK 导出，候选选项/签名不能写成已冻结 API。

没有发现四个实际 App 调用 useViewSnapshotTool，但它仍为公共导出，并在 snapshot-value-sdk、dual-producer、ref-v2-slice、w10-package-consumer 及 SDK public/type/integration 消费试件中使用。退出须先迁移其只读 Ref 参数合同、旧模式消费者、类型与实例绑定失效测试，明确 Ref/ArrayRef 完整能力与版本采用；保留当前 SnapshotValueRegistration 的真实责任。本批不删除、不宣称 Legacy 可退出。

SRT Owner 文档 2.3 的历史/目标段仍有 `(描述)[Type:Name]` 及省略前缀的名字示例，与 B23 实际默认说明不同。原件已保存，留给该 Owner 维护，不并发修改。重名、公开 helper/签名、版本正式采用、SRT-05 与最终 Legacy/Semantic 验收保持各自决定边界。

## 最小下一步：B25 隔离真实 Host 手测入口

负责人已下发 `MINIMAL_CORE_BATCH_25_TASK.zh-CN.md`，本报告采用该具体范围作为下一步，不另外发明协议或核心合并批次。

- 复用精确 B22 SDK 与已审 B23 Runtime 包；在 `.tmp/minimal-core-ref-acceptance-20261106/` 提取 M4.3 真实 Host/Planning。
- Planning 的 planning-tools.ts/PlanningApp.tsx 中仅变更 open_plan 声明和其业务绑定，复用已审 RefValue/Plan Schema；如真实 M4.3 组织方式不同，按原职责定位并保存原件。这一入口选择显式 Ref 参数语义，由 Core 解析原观察中获准的 Plan。既有 plan_id 查找属于应用业务检查，不能称为重复页面解释；应用仍按收到 Plan 中的业务 ID 核对当前是否可打开，相关查找和业务责任保留。其他工具原参数保持。
- Host 只复用既有实现及必要隔离路径，不写共享配置、聊天、Planning DB 或 Electron profile。正例是创建/关详情/复制 PlanList 完整 Ref/open_plan 打开正确详情；负例是错前缀、未知名字、上传对象在业务前拒绝，删除/关闭后遵守现有合同。验收还须实际启动 GUI、核对指定包载荷及数据隔离。
- Codex Prompt 以 B25 正式任务为准：原包不改不重打、不发模型请求、不改 root、不停止现有 Host，只交可启动环境、真实链路正反例和用户步骤，READY 后交两 Owner 独立复核。

隔离准备现已授权；共享 SDK 作者接口采用、协议版本升级、全 App 迁移、公开命名/helper 和最终 Semantic 验收未自动授权。本批没有要求重批已经批准落地的 B23。

## 验证、保护与限制

实际命令为 `python3 review-evidence/minimal-core-batch-24/compare.py <私有空目录>`，历史重建 check/apply 8 次成功、共享诊断检查 5 次预期失败；`node .../probe-capabilities.mjs <共享实际core/index.js> <候选包core/index.js> <输出>` 退出 0。原始输出与冻结 20 件共享 Core JS 原件已保存；README 提供隔离复跑方法。

最终核对：600 件源码/配置/调用方、460 件构建指纹没有变化，HEAD/index 相同。补充31件消费者及历史输入另有指纹。本批未新建生产 patch，没有测试 skip、依赖安装、共享构建、业务副作用或外部模型调用。其他 Owner 对进度与启动材料的并行更新单列在最终清单，不据此恢复旧文件。

没有重跑全 Runtime/SDK、真实 Worker、GUI、真实模型或新严格类型/声明检查；旧签收的 linkedom 130 项严格库诊断也没有被改记为本批通过。B25 GUI 与数据隔离验证尚待执行，不属于本报告的完成事实。
