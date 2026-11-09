# 公共消费者 TypeScript 兼容范围审查 · 2026-11-07

状态：**READY_FOR_REVIEW**。本次完成只读范围审查，等待 Minimal Core Owner 独立复核；没有执行兼容修复或改变支持政策。

r05 的隔离消费者迁移行为已经由负责人批准；完整退出仍为 **CHANGES_REQUESTED**，TS 5.3 adapter 门禁没有豁免。本报告不重新裁决这两项状态。建议先确定 adapter/Driver 的编译器支持政策，再单独下发依赖兼容实施任务；不要把现有开发依赖范围当作消费者最低版本，也不要让 App 用 shim 或降低检查来绕过问题。

## 1. 输入身份与本次边界

固定裁决为 [r05 负责人复核](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE/MINIMAL_CORE_SRT_02_CONSUMER_MIGRATION_REVIEW_2026-11-07.zh-CN.md)，SHA-256 `e873fdb83e414b41245aa5e79fe8d6cd8e26861fbcef43b7c804a7b54f260ed5`；机器签收 `review-evidence/srt-02-consumer-migration-r05-20261107/owner-review/final-signoff.json`，SHA-256 `07756965f547eec6d48ad5d47fc345103f7d1859757006bc43b6472f8c7d0edb`。

候选限于 `.tmp/srt-02-consumer-migration-r05-20261107/source`、`packages`，诊断使用 r04 的 `owner-review/run-and-type-diagnostic-review.json`、修正 ESM 标记后的 `driver-types-baseline-02`，执行事实使用 r05 `runs/attempt-01/result.json` 及负责人既有独立结果。SDK 是 r05 清单指定的 list-ref 候选，不能替换为同版本号的早期 typed-ref tar。

本次只新建本报告和 `review-evidence/minimal-core-consumer-type-compat-scope-20261107/`。使用 Python 标准库读取文本、JSON、计算指纹及提取记录；没有运行 TypeScript 编译器、测试、构建、安装、打包、项目模块、Runtime、Host、Worker、模型、GUI、网络或权限探针。原 Host preview 线保持冻结，第三轮 Host 未准入。

开工记录见 `baseline.json`。脚本静态核对 r05 清单中的 418 个 source 内容和负责人签收所列输入，并记录所读取公开声明的当前指纹；没有复制或重新封存整个依赖树。历史日志里的加载路径与本次读取时的文件指纹分别保留，不冒称重新执行了编译或逐文件证明了所有依赖在历史运行时的内容。所有旧材料、生产及依赖均未写入。

## 2. 已观察的编译矩阵

以下全部来自**已保存的实际执行**，不是本次新运行。[完整配置、命令、样本和退出结果](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-consumer-type-compat-scope-20261107/observed-matrix.json)。共同条件为 `strict: true`、`skipLibCheck: false`、ES2022、NodeNext module/resolution、ESM 消费者。SDK/adapter 使用 DOM 和 Node 类型；Core 使用 ES2022-only、`types: []`。

| 实际门禁与范围 | TS 5.3.3 | TS 5.9.3 | 证据边界 |
| --- | --- | --- | --- |
| `@aotui/runtime/core` 的 `tool-types.ts`，含 15 项负向断言 | exit 0 | 通过 | r05 为 ref-only，**没有**编译旧 Core 文档原例，也没有执行完整 W10 |
| `@aotui/sdk` Ref/普通工具子集，另导入 Runtime 根入口和 SPI；8 项负向断言 | exit 0 | 通过 | 不是单独的 `@aotui/sdk/tools` 门禁，也不是 SDK 全部作者 API 覆盖证明 |
| `@aotui/runtime/adapters` 的 Semantic Source，与 Driver Context、Core、SPI 联合；2 项负向断言 | exit 2，36 条诊断 | 通过 | adapter 有指向完整 `@types/json-schema/index.d.ts` 的精确 `paths`；没有证明无映射的普通安装 |
| 仅从冻结 Driver 根入口 `import type { ContextDrivenSource }` 的独立 ESM 对照 | exit 2，相同 36 条 | exit 0 | r04 baseline-02，分别加载 308 / 309 份声明；没有加载项目 SDK/Runtime 声明，没有启动模型或 Worker |

r05 执行方四步退出码为 **0 / 0 / 0 / 2**：第一步包含 TS 5.9 三个严格入口和四次公共调用，之后分别运行 TS 5.3 Core、SDK、adapter。负责人另行重跑 TS 5.9 公共链，通过；TS 5.3 Core/SDK 的报告范围是核验执行方日志，没有把它写成负责人另行重跑。

公开调用的历史结果为四次 handler 进入：两次 Ref 读取、一次 App guard 拒绝、一次业务写入；最新 View、短收据和正常 Runtime 关闭已有负责人验证。这不是本次新执行，也不是完整 Host/模型、全部发布时序或 Semantic 验收。

上述 TS 5.9 通过只说明 **5.9.3 + 这一依赖图/配置/样本**通过。不能据此写成最低版本是 5.9、5.7、5.4，或介于两者的版本都失败。`@aotui/sdk/tools`、memory-state-storage、独立根入口/SPI、CJS 和其他编译器版本未在本轮冻结 r05 门禁中分别验证，仍需与历史专项结果区分。

## 3. 最低版本承诺：已找到什么，仍不知道什么

本次限定检索 Root README/GUIDE、Driver README 和 r05 Runtime/SDK 包 README/docs，共 **30 份公共文档**；文件、逐条命中、原文和行号见 [支持承诺语料](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-consumer-type-compat-scope-20261107/support-doc-corpus.json)，manifest 原字段见 `declaration-chain.json`。结论为：**在该有界语料中，未找到明确的数字最低 TypeScript 消费者版本承诺；真正的最低版本政策仍未知，不能由本报告自行补写。** 这不声称仓库所有历史文件都没有承诺。

| 出处 | 原文或原字段 | 应如何解释 |
| --- | --- | --- |
| r05 `packages/driver/package.json:28`；SDK `package.json:46` | `"typescript": "^5.3.0"`，均位于 `devDependencies` | 工程开发依赖范围；不证明实际使用 TS 5.3，也不保证所有消费者声明可用 |
| r05 Runtime `package.json:70` | `"typescript": "^5.9.3"`，位于 `devDependencies` | 不是 Core 消费者的最低版本声明；三个项目包均未声明 TypeScript peer |
| r05 Runtime `README.md:8` | “`@aotui/runtime/core` is the pure TypeScript semantic Core for trusted producers and hosts that supply their own runtime integration.” | 入口与职责承诺，没有数字编译器下限 |
| Runtime `docs/sdk-runtime-distribution.md:15` | “可在 ES2022、无 Node/DOM 类型的消费者中使用” | Core / memory-state-storage 的环境承诺，不能扩大到 Node 根入口或 adapter；该段包含旧示例措辞，退出文档由 SRT Owner 单独处理 |
| SDK `docs/view-type-tools.md:37` | “The pure entry's runtime graph excludes Preact/DOM/Worker internals; installing SDK still has Preact as a peer and declarations still require DOM ambient types.” | `./tools` 运行图与类型环境明确不同；不能把运行图纯净理解为声明不需要 DOM |
| SDK `docs/runtime-compatibility.md:25` | “这些范围不是任意历史包互换的保证” | `^3.0.0` / `^0.3.0` 与同版本 tar 身份不能取代联合验证，也没有给出 TS 下限 |
| Runtime `docs/sdk-runtime-distribution.md:13,35` | “They are evidence for those artifact sets, not a description of the current supported API”；“不能把这一结果推广至任意未来依赖组合” | D5 / W10 的严格类型事实限定于历史产物；不是当前 5.3/5.9 或任意正常安装的支持保证 |
| Runtime `docs/mem01-closure-2026-11-02.zh-CN.md:31,70` | 历史 LSP 配置列出 TS 5.9.3，并明确不是对所有 TypeScript 版本/平台的承诺 | IDE 内存验收环境，不是公共声明最低版本 |

**当前准出门禁与未知的公开最低版本政策也必须区分。** r05 负责人签收明确保留 TS 5.3 adapter 失败、不改变最低版本。本次只能提交政策选项，不能因文档未找到数字而取消已经下发的门禁。

检索中两个旧根路径 `SRT-01_SINGLE_DECLARATION_PLAN.zh-CN.md`、`SRT-02_SNAPSHOT_TOOL_RETIREMENT_SCOPE.zh-CN.md` 不存在；按当前状态记录，没有恢复，也没有将缺失原件或其他旧证据作为本次新建产物。

## 4. 声明链与 36 条错误的归属

具体 import/export、行号、包依赖范围、实际版本和指纹见 [声明依赖链](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-consumer-type-compat-scope-20261107/declaration-chain.json)。链条为：

`@aotui/runtime/adapters` → `SemanticAOTUIDrivenSource` → Driver 的 `ContextDrivenSource / DrivenSourceContext` → Driver 根入口及 `core/interfaces.d.ts` → `ai` 的 `ModelMessage / Tool` → `@ai-sdk/provider-utils` 与 `zod/v4`。

adapter 声明首行已是 `import type`；这能避免执行 JS，不能免除传递声明的语义检查。Driver 的 Context 消息字段使用 `ModelMessage`，工具字段使用完整 `Record<string, Tool>`；根入口同时 re-export `jsonSchema`、`Tool`、Driver 和 provider 工厂。`ai` 声明前 12 行直接引入 provider-utils、provider、Node HTTP 和 Zod v4，provider-utils 同时引入 Zod v3/v4。只换成 type-only import、从 Driver 另设一个仍引用相同 AI 类型的子入口，都不能自动消除这条依赖链。

本次逐条比较 r05 adapter 与 r04 Driver-only 的 **文件、行、列、错误码、完整消息**。只去除已知文件系统前缀，不删诊断内容、不按 status 归一化：36 个诊断元组完全相同。原始日志、每条源码行和对照键见 [diagnostics.json](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-consumer-type-compat-scope-20261107/diagnostics.json)。

| 实际声明来源 | TS2304：缺少 `NoInfer` | TS2315：`Uint8Array` 不是泛型 | 合计 |
| --- | ---: | ---: | ---: |
| `ai@6.0.86`，`dist/index.d.ts` | 27 | 5 | 32 |
| `@ai-sdk/provider-utils@4.0.15`，`dist/index.d.ts` | 2 | 1 | 3 |
| `zod@4.3.6`，`v4/classic/schemas.d.cts:714` | 1 | 0 | 1 |
| 合计 | 30 | 6 | 36 |

实际加载的 TS 5.3.3 `lib.es5.d.ts:2151` 声明非泛型 `interface Uint8Array`，该文件没有 `NoInfer`；TS 5.9.3 同文件第 1680 行有 `type NoInfer<T> = intrinsic`，第 2165 行为泛型 `Uint8Array`。这是本次两个样本为何不同的静态解释，**没有据此断言这些能力最早在哪个编译器版本出现**。

归属判断如下：

- **冻结基线问题**：这 36 条错误由不加载项目 SDK/Runtime 的 Driver-only 对照复现；r04/r05 四份 Driver 声明也逐字节相同。因此没有证据将其归因于本次 list/ref 消费者迁移，不能要求修改 App Ref 调用来修复。
- **独立的声明解析问题**：`@ai-sdk/provider@3.0.8/dist/index.d.ts:1–2` 从 `json-schema` 导入/导出 `JSONSchema7`；其运行依赖是 `json-schema ^0.4.0`。Runtime 已声明 `@types/json-schema ^7.0.15`，但在当前链接图中不自动等于 Driver 侧查找可达。r04 实际 trace 已证明 nearest node_modules 命中 JS、没有回退至 typeRoots；r05 精确映射完整声明使这一 TS7016 查找问题关闭于该夹具。它没有解决上表 36 条版本错误，也没有证明一般安装无需映射。
- **未确认范围**：普通包管理器安装后的解析、其他 TypeScript / AI / Zod 版本组合、真实最低支持版本、所有作者 API 的兼容性。不能用已知基线失败豁免当前准出，也不能把本次未观察到错误写成全部可用。

## 5. 最小解决选项与决策边界

### 选项 A：继续履行现有 TS 5.3 门禁，解决 Driver 的类型依赖闭包

由单独任务选择并验证能在 TS 5.3.3 与 5.9.3 下同时表达**当前完整 Tool、Schema、模型元数据、ModelMessage 与 Context**的依赖闭包。现在没有已验证的候选版本，本报告不凭静态猜测指定降级或 pin 到某个版本。Zod 单独变更最多针对当前一组直接诊断；AI 的 32 条和 provider-utils 的 3 条仍需独立解决。

潜在改动是 Driver `package.json` 与实际拥有该依赖图的 lock/约束；需要时由类型依赖的生产拥有者承担缺失声明依赖。Runtime/SDK 不默认跟随改业务代码，任何跨包调整要单独列白名单。包依赖变更可能同时影响 provider 运行合同、Zod Schema 类型、模型元数据和单次执行保证，必须通过下节真实包消费与相关 Driver 运行回归；不得用类型强转、全局 `NoInfer`/`Uint8Array` shim、App 自配 `paths`、`skipLibCheck` 或缩减 Tool 字段来获得通过。

这是在**不改变现有编译器门禁**前提下的优先调查方向，但不是已经证明存在的修复。若没有保持语义的依赖组合，停下交负责人裁决，不建立新的兼容层。

### 选项 B：明确 adapter/Driver 的编译器支持政策

如果上级决定不再支持这些入口的 TS 5.3，可形成入口级的明确支持政策，并安排文档、验证矩阵和包声明审计。当前只有 5.9.3 通过证据；它可以成为拟议的首个验证基准，**不能宣称已经找到了真实最低版本**。Core/SDK 已有 5.3.3 通过事实，不能为方便整包使用一个新 TypeScript peer 范围，把它们一并抬高。

这项选择会改变既有准出要求及对外版本承诺，必须由有权负责人批准；本次没有执行。若需要确认比 5.9.3 更低的下限，测试版本及平台要先列入下一任务，不能在本次扩测。

### 两个选项共同需要处理的包解析责任

普通安装必须不依赖夹具中的绝对 `json-schema paths`。应先验证真实安装布局；若仍失败，再在实际导出 AI 类型的包或上游正确声明依赖处解决，不能把查找根配置交给每个 App。现在不将向 Driver 添加某个依赖直接写成“必然修复”，因为正常安装尚未验证。Runtime 现有类型依赖也不能未经验证删除。

**暂不采用的更大改造**：重写 Driver Context 为自有简化消息/Tool 类型或拆一个公共协议包。当前 Context 本来就承诺 AI 的完整类型；简单换入口不解决问题，截断类型又会改变公共合同。它需要独立架构理由、公开 API 决策及元数据/Schema 等价证明，不是这次兼容问题的默认补丁。

## 6. 下一次正式包消费者验证计划（仅计划，未执行）

1. **先确定准出政策与输入**：负责人指定选项、允许修改文件、待测精确依赖图和三个正式 tar 身份。Runtime/SDK/Driver 必须有完整产物清单与 SHA，不能用同版本号或工作区目录代替；冻结 Driver 若没有正式 tar，先另行准入产物准备，不在本次打包。保留原失败作为对照。
2. **正常安装消费者**：在下一任务明确批准的新隔离根中建立两个空 ESM consumer（TS 5.3.3、5.9.3），从审定 tar 进行真正包管理器安装，使用明确的完整离线缓存、独立 cache/temp/lock，禁用安装脚本，不联网、不使用工作区软链或源码 alias。不更改用户 HOME、配置、手测 profile/DB。缺依赖/缓存不足属于环境阻塞，不能记作语义红灯或通过。解析并核对唯一 Runtime/SDK/Driver 的实际路径、版本、文件指纹与依赖树；依赖 overrides 只能用于负责人明确批准的包身份，不临时绕过第三方约束。
3. **显式消费者依赖**：TS 两个精确版本；SDK 的 Preact peer（当前对照为 10.29.1）和 TypeBox 1.4.3；Node 类型（当前对照 20.19.35）用于 SDK/adapter/Driver profile，Core profile 仍 `types: []`。Runtime 的 linkedom、Driver 的 AI/provider 包、Schema 类型依赖由各自正式 manifest 正常安装，不能靠另一个工作区的 store 偶然可见。当前对照的 AI 6.0.86 / provider-utils 4.0.15 / Zod 4.3.6 作为对照身份，候选更改另列。`@types/json-schema` 的框架依赖应从包图获得，不能要求 App 私配绝对路径来宣称安装通过。
4. **六个分开的类型样本**：① Core（ES2022-only、无 Node/DOM）复用 15 项负向断言；② memory-state-storage 同环境验证真实 StateSession 使用；③ SDK 根入口（DOM，必要时 Node）保留普通工具、typed Ref、ArrayRef 的 readonly/参数负向断言；④ SDK `./tools` 独立导入，其声明需要 DOM，不能套用 Core 无 DOM 要求；⑤ adapter + Context release + Core/SPI；⑥ Driver 根入口的类型消费者，包含消息、完整 Tool/Schema/元数据。Runtime 根入口/SPI 在现有 SDK/adapter 联合样本中继续消费，若要单独宣称两者全面兼容需另列样本。
5. **命令与解析门禁**：每个样本使用 consumer 内已安装的精确编译器执行 `tsc --noEmit --listFiles -p <profile>`；`strict: true`、`skipLibCheck: false`、ES2022、NodeNext 固定。adapter 和 Driver 另保存 `--traceResolution` 的目标模块段及实际加载清单，正式正常安装门禁不允许 `json-schema paths`、自写 ambient 声明、全局 shim 或类型检查绕过。记录完整 argv/cwd、工具版本、退出码、原始 stdout/stderr、声明与依赖指纹；正例无诊断且负例真实生效才算通过。新版本不同诊断不能归一化后抹掉。
6. **运行证据独立准入**：类型通过不等于业务语义通过。若实施改了 Driver 运行依赖，应在另行批准且能隔离应用模块副作用的运行环境，复用既有单执行、停止门禁、消息元数据、Context release 回归，以及已准入的 SDK→Runtime Worker→Source 四次调用，核对短收据、最新 View、实际业务次数和正常关闭；不扩展真实模型、GUI、IDE/LSP或私有手测。不把此次静态范围包当作运行准入。
7. **释放、重放与失败归类**：类型进程正常退出；若后续获准启动 Worker/Runtime，需真实关闭并等待在途责任结算，不能用 kill 代替资源释放。保留 lock、产物身份、日志和需要审阅的输出，再仅按新任务约定清理它创建的 scratch。用同一 lock 在第二空 consumer 普通离线安装，检查解析与 payload 身份。保留任何失败，不扩权或自动重试未知写入。

成功条件取决于事先批准的政策：若保留 5.3，则所有指定 5.3/5.9 门禁均须通过；若改变支持范围，必须先有批准的版本政策，且不能把被取消的门禁写成通过。`json-schema` 正常解析与其他声明合法性分别通过；相关运行语义无回归；负责人独立复核后才可解除对应兼容阻断。**链接消费者成功不等于正常安装成功；正常安装成功也不等于发布或 Semantic 验收。**

## 7. 自审、失败与交付

本次没有生产改动、依赖变更、公开 API、shim、缓存、管理器或新状态；没有修改 README、deepseek_review、SRT Owner 的退出清单/登记、旧裁决或 owner-review。所保留的 21 份小型原件副本来自既有日志、结果、配置和样本，明确标识来源；未复制依赖树。

静态提取脚本第一次因遇到 Zod 子入口的无 `name` package.json 而发生 `KeyError`，随后改为读取三个明确的包根 manifest。初次脚本及 stdout/stderr 原件保留，后续提取退出 0。这是证据提取程序的问题，不是产品回归、编译失败或先红。另有命令误用历史日志文件名、读取两个已缺失根文档路径，均据实记录；没有恢复文件或据此改变结论。

本次未执行任何产品测试、类型检查或普通安装。证据中 5.3 / 5.9 退出及 36 条错误为历史实际结果，本次只静态复核。对任意未测版本、正式安装、全量作者 API、运行隔离、旧路径删除和最终 Semantic 验收不作通过声明。

交付索引为 [INDEX.zh-CN.md](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-consumer-type-compat-scope-20261107/INDEX.zh-CN.md)；输入引用、原件副本、诊断/声明链、命令、保护项及所有本次新增文件指纹在该目录与 `final-delivery.json` 中。该清单区分新增副本和原有输入，不将负责人或其他执行线材料记作自己的新增产物。本批是只读范围包，不生成生产 patch。
