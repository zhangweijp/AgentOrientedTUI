# SRT-06 单点声明实验独立复核

日期：2026-11-07。执行：SRT Owner。独立复核：Minimal Core 负责人。

**限定实验与根因结论 APPROVED；正常发布包的完整集成准出仍为 CHANGES_REQUESTED。** 这是 `LOCAL_DECLARATION_EXPERIMENT`，不批准修改生产依赖、公开支持政策、共享采用或发布。

独立实证确认：在本次精确安装图中，给第三方工具类型的一处分支补上其已经声明的无输出形状，足以消除 TS5.9.3 的原八条严格类型错误。TS5.3.3 的编译器能力问题仍存在，且已观察到一条负向类型约束失效。这两件事必须分别处理。

## 1. 输入、唯一差异与证据身份

执行方 [报告](../review-evidence/srt-06-driver-declaration-probe-20261107/REPORT.zh-CN.md)及 [41 件提交清单](../review-evidence/srt-06-driver-declaration-probe-20261107/submission-manifest.json)已经封存。清单 SHA256 为 `c78abd229295f0861ca69943a97fbd65f1a4c7048fc9ba70dd23d58ce75ca673`。

本批同步更新了当前进度 README 与 B 方案说明。它们曾作为 r02 签收引用，因此现在不能再声称原 28 个路径的内容全部未变：26 件原路径仍一致；两份当前文档的签收版本已经在更新前逐字保存，均匹配原 SHA。原 r02 签收不改写，具体前后映射见 [文档演进审计](../review-evidence/srt-06-driver-declaration-probe-20261107/owner-review/r02-reference-evolution.json)。首次生成本批机器回执时严格指纹检查因此停止；已向执行方更正尚未生成回执的事实，随后按上述明确分类重新生成，历史内容没有丢失。

输入明确是诊断批的 **ai 6.0.324／provider-utils 4.0.64／zod 3.25.76** 正常安装图，不是原 B r02 的 zod 4.6.7 图。负责人逐项核对原图 6324 个文件／内部符号链接条目及执行方改后 6326 项；两项新增只是完整 Tool 类型试件。

负责人另建 `/private/tmp/aotui-type-independent-probe-w3esikz3/consumer`，从原图物理复制，校验文件内容、内部链接及普通文件 inode 不同；再添加相同试件。唯一第三方差异是 `@ai-sdk/provider-utils/dist/index.d.ts` 的 NeverOptional any 分支。

负责人独立重放生成的 patch 与执行方 [declaration.patch](../review-evidence/srt-06-driver-declaration-probe-20261107/declaration.patch)逐字一致，SHA256 为 `ec7375fae39a42d3172fa6734689672da708f30e2b9463cf79052f248fadde5d`。所有运行时 JS 不变，原消费者和执行方实验副本在复核后保持原指纹。

## 2. 实际独立验证

负责人在自己的物理副本执行改前／改后、两编译器、三入口，共 12 次检查。完整 stdout（含实际加载文件）仅归一消费者根路径后与执行方逐字一致；strict、exactOptionalPropertyTypes:true、skipLibCheck:false 和原公共试件保持。

| 入口 | TS5.3.3 改前 → 改后 | TS5.9.3 改前 → 改后 |
| --- | --- | --- |
| Driver-only | 51 → 47，失败 | 8 → 0，通过 |
| 完整适配包集成 | 51 → 47，失败 | 8 → 0，通过 |
| 完整 Tool 正负向试件 | 55 → 48，失败 | 11 → 0，通过 |

TS5.3.3 原两个入口仅移除了四条 TS2344；其余 41 条 NoInfer 和六条泛型 Uint8Array 错误的诊断块保持逐字一致。新增完整 Tool 试件仍有一条 TS2578：错误 inputExamples 没有受到预期类型拒绝。该负向失败在改前已经存在，不能删断言或将它记为单点改动回归。

负责人另将五条 `@ts-expect-error` 注释从自己的附加试件中移除，执行第 13 次 TS5.9.3 检查，实际得到五条预期的业务类型错误，且全部定位在相应试件：错误输入、错误输出、非 JSON metadata、错误 inputExamples、缺少具体输出。原执行方试件未改。这证明本批绿灯没有依赖失效的负向断言。

完整 Tool 的 never／any 四组合、无输出的显式 undefined、metadata、输入示例、执行及生命周期回调、dynamic／provider 分支和完整 ModelMessage／Context 均在列明试件内验证。没有声称穷举全部第三方消费者或运行时行为。独立命令、退出码和日志见 [attempt-02 审计](../review-evidence/srt-06-driver-declaration-probe-20261107/owner-review/attempt-02/independent-probe.json)。

复核的第一次尝试在补丁应用前停止：TypeScript 按字符数截断错误消息中的绝对路径，负责人目录更短，导致两份等价诊断在省略号之前保留的字符不同。原脚本和失败输出保存在 [attempt-01](../review-evidence/srt-06-driver-declaration-probe-20261107/owner-review/attempt-01/failure.json)。第二次使用与执行方等长的新目录，保留完整日志相等断言后通过；没有将类型差异过滤掉。

## 3. 可批准的结论与未覆盖风险

批准当前精确图的这条局部根因：NeverOptional any 分支未容纳既有 never 输出形状，造成所测严格可选属性错误。列明公开类型反例保持有效，且未改变运行时 JS。

正常发布的依赖没有被修复。复制后手改 `.d.ts` 不能成为对下游的交付承诺；仓库根的 overrides 或补丁设置也不能默认传播到独立包消费者。上游正式修复是否已有可采用版本、是否维护临时补丁及其分发方式，均须明确来源与实际安装证明。

TS5.3.3 兼容仍不成立。仅提高编译器要求也不能修复原发布包的严格可选属性问题。不能把实验中的 TS5.9.3 绿灯当成支持政策已变更，也未证明 TS5.7 或其他未经测试的中间版本已通过。Runtime／SDK 独立消费的原批准保持。

本次没有运行 Host、GUI、真实模型或重复 Runtime 大套件；没有修改原 trial、原 tar、B r02 或共享生产。SRT-05、共享采用和最终 Semantic 验收仍分别跟踪。

## 4. 下一批范围、准出条件与 Codex Prompt

下一批准备可审阅的正式交付选择，不再用无边界的版本试探或声明改写追求绿灯。

需要交付三件具体材料：第一，说明保留全链 TS5.3.3、仅调整 Driver／适配包支持范围、暂不放行完整集成这三个选择的影响、维护成本和推荐；第二，准备不发送的上游最小修复材料，明确公共包安装必须取得何种可验证来源，不能假定根补丁会传递；第三，只读整理不依赖这项 Driver 阻断的 SRT-02 剩余隔离范围、输入和验收条件，防止无关工作一起停住。

准出时须明确区分语言支持政策和依赖声明修复，并给出所推荐方案的生产影响文件、必要受控 provider／streamText 行为验证、最终正常安装与完整类型门禁。上游接收、正式版本、临时 fork 或支持政策都不能以推测代替事实。若关键选择需所有者决定，先形成完整方案和具体最小决策项。

可直接转交的 Codex Prompt：

> 从已批准的单点实验和封存 B r02 出发，仅准备正式兼容交付选择文档、不发送的上游材料与独立内核剩余范围。解释两个独立阻断，列出完整 TS5.3 支持、Driver／adapter 使用已实测编译器要求但 SDK／Runtime 保持原支持、暂不放行完整集成三种选择的成本、风险和推荐。只读核查正式依赖出处；明确补丁不能靠根 overrides 自动传播。列明未来生产修改与受控 provider／streamText、正常安装、完整公开类型的准出条件。另整理不依赖该 Driver 变化的 SRT-02 隔离任务输入及门禁。不得修改生产或原证据、改变支持政策、增加第三方声明补丁、发上游消息／PR、采用新大版本、启动 Host／GUI／真实模型或发布。完成后交 Minimal Core 独立复核，并把真正需要所有者决定的最小事项单独说明。
