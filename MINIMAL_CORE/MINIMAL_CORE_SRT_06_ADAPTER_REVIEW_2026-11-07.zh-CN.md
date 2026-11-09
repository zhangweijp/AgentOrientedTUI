# SRT-06 B 独立薄适配包：r02 独立复核

2026-11-07。执行者为 SRT Owner；本裁决由 Minimal Core 技术负责人独立核对、重建和复验后给出。复核期间未修改执行者的生产候选。

**APPROVED：B 方案的限定隔离迁移、Runtime／SDK 独立包消费，以及本报告列明的集成运行行为。** r01 的两项 P2 迁移遗漏已经修正；启动脚本接线也已纳入具名范围并验证调度。

**CHANGES_REQUESTED：完整集成准出。** 正常安装已通过；Driver 公开类型在 TS5.3.3／5.9.3 的完整严格选项下仍分别有 51／8 条错误。该阻断不因包边界正确、运行行为通过或错误来自第三方声明而豁免。

本裁决不包含共享采用、推送、合并、发布、提高 TypeScript 支持下限、真实 GUI／模型验收或最终 Semantic 验收。也不宣称 SRT-02 全部形状、SRT-05 新观察自动撤销或 Host 预览缺陷已经完成。

**1．批准的精确候选**

候选为 `.tmp/srt-06-adapter-package-20261107/source-r02`。原 r01 源码、补丁和失败记录保留不动。

| 身份 | 独立核对结果 |
| --- | --- |
| 原始输入 | 730 份：412 份封存 Group A 输入、318 份当时共享代码只读输入；全部来源指纹仍一致 |
| r02 新增输入 | `run.sh`、`setup.sh` 两份具名原件，另列指纹；未改写原 730 清单 |
| 联合基线与最终源码 | 732 份基线；52 个变更路径；独立重放后 738／738 文件一致 |
| 累计 patch SHA256 | `0069c076f9e92309dfa2896b8943b9ccbf1272fd6a6c412e58a07411f03e5148` |
| 最终源码清单 SHA256 | `ca0390b397a49498f5ce668dbb3b997b20213e33c11e6e70ee156e50e1658f67` |
| r02 相对 r01 | 仅根 package／lock、GUIDE、Semantic Host 文档、run.sh、setup.sh 六文件 |

原始入口：[交付说明](../review-evidence/srt-06-adapter-package-20261107/delivery-r02/DELIVERY.zh-CN.md)、[累计补丁](../review-evidence/srt-06-adapter-package-20261107/delivery-r02/cumulative.patch)、[源码清单](../review-evidence/srt-06-adapter-package-20261107/delivery-r02/source-final.json)。负责人证据：[r01 独立重放](../review-evidence/srt-06-adapter-package-20261107/owner-review/identity-r01.json)、[r02 独立重放](../review-evidence/srt-06-adapter-package-20261107/owner-review/identity-r02.json)。测试完成后再次核对，独立副本和执行者 r01 均未发生源码漂移。

**2．改动与职责归属**

`SemanticAOTUIDrivenSource` 及 Options 从 `@aotui/runtime/adapters` 迁至 `@aotui/agent-driver-adapter`。新包以必需 peer 声明 Runtime `4.0.0-srt06.1` 与 Driver `^0.3.0`；本次实际检验的 Driver 为 `0.3.0`。SDK 候选 `0.5.0-srt06.1` 精确依赖这份 Runtime。候选版本尚未发布。

Runtime 删除 Driver 的生产依赖与旧 Source 出口，没有转发入口重新引回 Driver。Driver 的生产源码和包合同未改。新的适配包只公开现有 Source／Options；它没有第二个执行器、注册框架或业务状态管理器。Host 五处生产导入及相关消费者、mock 和当前文档迁移到新入口。

Source 从 `export interface SemanticAOTUIDrivenSourceOptions` 到文件尾逐字节一致，SHA256 为 `64942d1b002c26040c1645415ebaacd40ff3e04d78a07ec1576e2c61a044d498`。presentation 实现和测试逐字节迁移；指令加载函数正文与默认指令正文保留原样。因此本批没有重写 Context 捕获、收据映射、调用派发或 release 算法。构建和实际包运行证据补充验证了新的导入边界。

Runtime 通过既有 adapters 入口公开现有 `buildPublicToolName`、`buildViewMessageMarkup`，继续共用原实现。SDK／Core 的参数编译、Ref 解析、身份、授权与释放仍留在原模块。实际生成 JS／声明的 AST 核对表明：Runtime 无具体 Driver／适配包导入，Driver 无 Runtime 导入，适配包只通过 Runtime 的 `adapters`、`core`、`spi` 公开入口连接。[生成代码的导入检查](../review-evidence/srt-06-adapter-package-20261107/owner-review/emitted-import-ast-r01.json)

按 Minimalist 的四个问题，本批退出的是 Runtime 中的 Driver 专用代码、旧公开出口和直接依赖；既有适配实现继续承担连接责任，Core 继续承担语义保证；下述真实包和运行验证证明迁移范围；App 作者的工具／Ref 写法不增加步骤。增加一个包的安装与版本配对成本由宿主集成承担。前批净删 1594 行属于旧工具清理成果，不重复计为本批成果。

**3．审查发现与修正**

| 发现 | 修正与复核 |
| --- | --- |
| P2：外移根集成测试直接 import esbuild，根 manifest 未声明，临时构建链接掩盖缺口 | 根显式声明 `esbuild ^0.27.2`，实际锁定 `0.27.7`。执行者正常 pnpm 冻结安装根依赖成功；负责人使用这套正常根测试依赖，在独立源码重放副本运行 30 项集成全部通过 |
| P2：当前 Host 接入示例仍导入已删除的 Runtime Source，源码链接和测试命令过时 | 当前 import、配套版本、源码路径、适配器／根测试命令及 GUIDE 已同步；历史验证记录保留 |
| 执行者补充：run.sh／setup.sh 仍把 Driver 连回 Runtime，缺少适配包接线 | 具名纳入 r02；添加适配包安装、链接、构建顺序，只清理旧脚本自己创建的精确 Runtime→Driver 链接。双方分别在受控替身环境验证三个场景；未运行真实 Host、全局链接或 App 注册 |

[原 r01 审查发现](../review-evidence/srt-06-adapter-package-20261107/owner-review/findings-r01.json)保留 CHANGES_REQUESTED 的当时状态。r02 根 lock 的大量文本差异来自格式重排；独立解析后只有新增 esbuild 根 importer 一项结构变化，既有依赖解析未改变。[lock 结构对照](../review-evidence/srt-06-adapter-package-20261107/owner-review/lock-semantic-diff-r02.json)

另有一项旧 Source 测试迁移：原用例构造已经退出的 `view-instance` 成功路径，执行者在封存 Group A 中复现同样失败。新候选改为明确拒绝旧执行形状、无可见工具且零 Scope 派发；没有修改生产算法。负责人核对原输入、原失败和新断言，并运行现行 Ref 原观察来源、跨实例拒绝及 codec 合同测试。该旧形状退出测试不能代替现行 Ref 的正负验证，也不能倒写 Group A 的历史裁决。[原失败及修订依据](../review-evidence/srt-06-adapter-package-20261107/legacy-test-migration.json)

**4．实际验证与覆盖边界**

| 检查 | 负责人独立验证 |
| --- | --- |
| 四包构建 | 从独立重放源码重新构建；443 份 dist 文件与交付逐字节一致。r02 没有生产源码变化，另核对其全部 dist 相同 |
| 适配器与 Ref 来源合同 | 66／66：Source 41、presentation 2、Ref codec 16、Core 观察协调 5、Ref 准备 2；正常退出 |
| 外移跨包集成 | 30／30：真实 Receiver／Registry、空 View 的真实 Worker、Runtime 生命周期与失败边界；从独立 r02 源码和已核对产物运行，正常退出 |
| 两组正常包安装 | 在仓库外新空目录执行 npm ci，使用执行者正常在线安装所得的精确 lock 与缓存副本；无手工 node_modules 装配、无祖先 node_modules。两组 ci 和 npm ls 均通过；安装脚本禁用，未联网 |
| Runtime／SDK 独立消费 | 安装图无 Driver／AI SDK；TS5.3.3／5.9.3 的 strict、exactOptionalPropertyTypes:true、skipLibCheck:false 均通过，无 paths 覆盖。精确 Core／Runtime 教程两版通过，真实 Worker 两次调用及正常关闭通过 |
| Runtime＋Driver＋adapter 集成行为 | 四次公共 Ref／普通路径调用为三次成功、一次预期 FILE_NOT_OPEN；4 次 handler 进入、1 次 App guard、1 次业务写入。原／新 Ref payload 冻结、短收据、最新 View 替换及 Runtime 托管资源正常释放均验证 |
| 两版完整集成类型 | 仍失败：TS5.3.3 为 51 条，TS5.9.3 为 8 条；同图 Driver-only 的完整诊断逐字相同，加载文件没有 Runtime／SDK／adapter 声明 |
| 启动脚本 | 独立运行三场景语法与命令替身调度：已就绪 run、缺 adapter 的 run、setup；校验链接和构建顺序。所有实际外部动作由替身截获，文件操作局限 fixture；仅证明调度 |
| Host tsc 与受控测试 | 核对执行者 tsc 通过及 25／25 原始结果、精确输入和 mock 迁移；负责人本批未另启 Host 测试、GUI 或真实模型。r02 Host 输入不变 |

负责人原件：[构建与 66 项测试](../review-evidence/srt-06-adapter-package-20261107/owner-review/independent-r01/result.json)、[30 项集成](../review-evidence/srt-06-adapter-package-20261107/owner-review/integration/owner-r02/result.json)、[独立正常安装](../review-evidence/srt-06-adapter-package-20261107/owner-review/public/owner-r02/result.json)、[完整消费者命令结果](../review-evidence/srt-06-adapter-package-20261107/owner-review/verification/owner-r02/result.json)、[最终包与行为审计](../review-evidence/srt-06-adapter-package-20261107/owner-review/public-final-r02-audit.json)、[启动脚本调度](../review-evidence/srt-06-adapter-package-20261107/owner-review/launchers-r02/result.json)。

最终 Runtime tar SHA256 为 `f381e5fa56f3c08eeb53049f4911c772353bd93108c0aacaf0ad4ada67e15cb6`，其余三包与 r01 相同。负责人逐个检查包内文件同时匹配独立源码／构建副本和新安装目录：Runtime 367、SDK 78、Driver 18、adapter 14 件。完整指纹见最终包审计。这里的正常包安装不代表整个仓库或 Electron 安装已经验收。

**5．尚未覆盖的风险与阻断**

当前正常安装解析为 ai `6.0.324`、provider-utils `4.0.64`、zod `4.6.7`。TS5.3.3 的 51 条诊断为 41 条 TS2304、6 条 TS2315、4 条 TS2344；TS5.9.3 的 8 条均为 TS2344。完整诊断和实际类型文件路径已保留。历史 Group A 的 42／10 来自另一依赖图，不能把数量变化称为同一输入的修复或回归。正常安装中原 json-schema 解析问题未再出现。

公共 Ref 验证脚本同时检查类型和业务：由于保留类型失败，整个脚本 exit 1；其业务 case、四次调用和正常关闭确实通过。本报告分别报告这些事实，不将脚本标为全绿。

本批使用 Node 24.15.0；没有扩张为所有 Node／操作系统、Electron 打包、GUI 自动刷新或真实模型验证。根依赖安装、包消费者安装及各包本地构建依赖分别记录；没有把本地构建链接称作全仓正常安装。共享采用前仍需针对当时工作树检查冲突、消费者和合格隔离条件。本批不触碰既有私有手测 profile。

公共 Ref 行为试件实际调用 Source 本轮捕获的 `executeTool` 闭包，使用真实 SDK、Runtime 和 Worker；该证据不扩大为本批已经重跑模型请求和 Driver 整轮执行。Driver 执行源码保持不变，Host 受控回归按上表所列执行方结果核对。

SRT-05 的新观察自动撤销、SRT-02 多 Ref／可选组合、MC-HOST-PREVIEW-01 等保持各自状态；合法同时持有两个 Context 的既有行为没有被此次搬迁改写。

**6．下一批具体范围与准出条件**

下一批聚焦 Driver 公开声明兼容，先形成可执行的最小修复方案，不继续搬代码。执行者仍为 SRT Owner，负责人独立审查。

允许在新的隔离消费者目录中保存精确 manifest／lock、原最小 Driver-only 输入、两版编译配置、必要的依赖版本试件、原始诊断与推荐方案。保留本批 r02 源码、产物、失败证据及共享代码。可以测试候选依赖组合；尚不把任何组合应用到 Driver 或共享工作树。

准出要求：解释每类诊断实际来自何处；对任何推荐组合给出正常安装、TS5.3.3／5.9.3 完整严格检查，以及公开 Tool／Context 合同没有被隐藏或缩窄的证据；若涉及依赖版本变化，列明受到影响的 Driver／provider 行为验证和必要生产改动。不可行的组合保留失败记录。若现有支持范围无法同时满足，应提交具体取舍，由所有者决定重大政策变化。

可转交的 Codex Prompt：

> 以 SRT-06 B r02 的冻结 Driver 0.3.0、最终正常安装 lock 和 Minimal Core 独立复现为输入，在新的隔离消费者目录调查公开类型兼容。当前 ai 6.0.324／provider-utils 4.0.64／zod 4.6.7；TS5.3.3 为 51 条、TS5.9.3 为 8 条，Driver-only 与完整集成诊断逐字一致。复用该最小复现，按错误来源测试有依据的最小依赖组合，不做无界版本穷举。保留 strict、exactOptionalPropertyTypes:true、skipLibCheck:false 和两个编译器；保持完整 Tool、DrivenSourceContext、ContextDrivenSource 类型。只写新消费者、lock、试件、证据和方案；不改 r02／共享生产、不补第三方声明、不加 shim、不提高编译器下限、不缩窄公开类型。提出最小生产修改清单、行为验证范围、利弊和推荐，交 Minimal Core 独立复核后再实施。不得启动真实 Host／模型、读取私有 profile、发布或重新引入 D3。

常规兼容诊断继续推进；若最终需要改变公开合同或支持政策，再携具体方案升级，不要求用户重复确认已经选择的 B。
