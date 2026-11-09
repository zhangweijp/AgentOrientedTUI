# Minimal Core Batch 09 交付报告

**状态：READY_FOR_REVIEW。** 本批实现和执行者门禁已完成，等待负责人独立复核；不表示 APPROVED、发布通过、项目所有者 Semantic 验收或 Legacy 退出。

独立 patch：`MINIMAL_CORE_BATCH_09.patch`，SHA-256：

```text
8cb6cec060457de802277a7e82fba8c419e7bfff2b1d25de09aaf20e73e9374b
```

## 1. 完成范围与允许差异

五个真实 Host Source 已统一到既有 `getContext()` 合同。Driver 只使用本轮 Context 的消息、工具和执行器，删除 split 捕获及两处 Source executor fallback。`DrivenSource` 是 `ContextDrivenSource` 的同形别名；旧 `IDrivenSource`、公开导出和三个 `?: never` 字段退出。

本批包含两项有意的身份行为修复：

- MCP：旧 Context 固定原 Tool、执行函数和接收者。捕获 B 或替换原对象的 `execute`，不再把 A 的旧调用转给后来执行器；执行前复核 Source、tool、server 控制，禁用时业务零进入，返回 `rejected / E_SOURCE_UNAVAILABLE`，不发执行完成通知。
- Host：读取开始前捕获 topicId，消息与 compaction 目标一致。切换 topic 后，旧调用先返回 `rejected / E_SOURCE_UNAVAILABLE`，再无参数解析或服务调用；空 summary 同样先拒绝。新 Context 正常操作当前 topic。仍是 ID 相等检查，不增加 A→B→A 的 epoch 保证。

迁移 Source 的捕获失败在自身边界诊断原错误并返回完整空 Context；下一次显式捕获可以恢复。普通 atomic Source 的 `getContext` 抛错仍终止本轮，并逆序释放之前的 Context。SystemPrompt 初版漏掉的读取异常隔离已按负责人发现局部修复，详见第 5 节。

保留 `getToolSource`、Map 更新时间和捕获失败时的原 Map；保留同名后源覆盖、Context this、缺执行器/未知工具区别、逐次 stop/禁用门禁、串行、pending、debounce、状态机、消息规范化和释放时序。LLMClient 生产代码未改。MCP 字符串/对象 JSON/`Error: …` 映射、原调用 options 和已进入操作的常规通知行为保持。IM 的 historyLoading、合并、持久化、compaction 和 Batch 07 续跑合同保持。

## 2. 实际基线与保护

开工记录见 `review-evidence/minimal-core-batch-09/baseline.json`、`worktree-start.json`、`protected-start.json`、`git-status-before.txt` 和 `before/`。时间为 `2026-11-05T02:48:35.801084+00:00`，HEAD 为 `8938449925ada2f92e072e1c0492af8f2428d14f`。

记录了 1,877 个路径的实际存在状态和内容指纹，包含原有未提交、未跟踪实现及历史材料。预计改动路径按实际内容保存 preimage；新 Skill 测试在基线不存在。独立 patch 从这些字节生成，不使用 HEAD 的全部 diff。额外授权文件的原件来源另记：IM 类型在开工时已作为只读边界证据保存；compaction fixture 和 MCP index 后补保存的内容均核对与开工指纹一致，没有回写原基线。

根目录历史文档/patch 在开工时已有缺失，按实际状态记录，未恢复；清单中的历史路径候选不等于证明每个组合路径曾经存在。Batch 08 的批准事实沿用用户及开工时读到的负责人记录，本批未重开。

### 新发现的历史证据损失

保护核对另发现：**开工时存在的 Batch 01–08 共 963 份证据文件在执行期间变为缺失**。观察路径及开工 SHA 保存在 `historical-protection-drift.json`；本批没有恢复或删除这些目录，不把缺失伪装成仍然在场或重新核验通过。

项目所有者随后明确回复：**“确认有意清理，按外部变化记录并继续”**。处置记录在 `historical-protection-disposition.json`。因此将这 963 项列为所有者确认的批外变化，排除在本批 patch 外；原件损失事实仍在。`scope-audit.json` 的状态明确为 `PASS_WITH_OWNER_AUTHORIZED_EXTERNAL_HISTORY_REMOVAL`，不是“全部历史文件未变”。本批自己的 preimage、声明、日志和交付原件均在项目目录。

### 授权增量与材料归属

原任务书开工 SHA 为 `5a195a36603bae8bdd51465c59ed72cfe58ed3af182172e51f169358abd05299`；修订 04 后为 `72a4440e03e7b31b9ebdbdef3cede1c6877677745b0b69e3b653f5ce7ee7871a`。任务书由负责人修订，本批 patch 不含任务书。

| 授权 | 限定内容 | 依据 |
| --- | --- | --- |
| revision 02 | `host/src/im/types.ts` 只删除 IMDrivenSourceLike.getMessages 必填字段 | 实际语义边界 0 → TS2741 → 内存最小修复 0；真实最终 Program 再为 0 |
| revision 03 | compaction integration 的两个既有 fixture 各补 `notifyNewMessage: vi.fn()` | 原 2 项失败；相同未迁移生产版本下补齐后 3 项通过；不计身份先红或真实续轮证据 |
| revision 04 | MCP 工厂复用 Driver 已公开 Tool/jsonSchema，等价对象保留 dynamic | TS2322/TS2589 → 最小内存修正 0 → 实际候选语义 0；不升级依赖或增加强转 |

`scope-revision-01/` 的四份文件是开工已在场的负责人材料；02–04、`owner-review/` 以及负责人并行新增的 Batch 10 任务书、两份 MINIMAL_CORE_LEAD_* 交接文档属于负责人材料，不能算作执行者新产物。执行者观察/处置记录属于本批证据。最终清单分组记录这些来源，不将引用的历史证据列为自己的新增交付。

## 3. 实际依赖、构建和测试入口

执行环境为 Node `v24.15.0`、pnpm `10.15.1`、TypeScript `5.9.3`、Vitest `3.2.4`。Driver 解析 AI SDK `6.0.86`，Host 解析 `6.0.97`，Host 直接 Zod 为 `3.25.76`。真实路径和文件 SHA 在 `dependency-resolution.json`。它是在最终验证阶段采集的解析记录；开工时实际编译输入和编译器版本则由 `baseline-declarations.json` 记录，不把后采集信息冒充开工快照。

所有保存的 package/lock/tsconfig 与开工原件一致。跨包 Host/Runtime 测试解析到实际 `agent-driver-v2/dist/index.js`；Driver 经 `pnpm build` 重建。包消费使用本轮真实 `pnpm pack` tarball，16 份 dist 文件及 README 与当前产物逐字节一致，无 registry 安装、发布或源码别名冒充包消费。

严格检查沿用项目原有 `strict: true`、ES2022、模块解析及 `skipLibCheck: true`；没有改 tsconfig 或新增 suppression。Host 入口使用真实语义 Program，测试检查在同样严格选项下扩展 root 集合，没有以 isolated/transpileDeclaration 代替。

## 4. 生产、测试及文档差异

独立 patch 共 25 个路径：12 个生产文件、11 个既有测试文件、1 个新 Skill 测试和 1 份 README。全部路径、前后 SHA、增删行及准出命令在 `patch-gates.json`。白名单中实际未改的两个 Driver 测试文件为 `tool-execution-owner.test.ts`、`context-regions.test.ts`；未改文件也参与必要回归。

| 生产文件 | 实际职责变化 |
| --- | --- |
| Driver interfaces / index | 删除旧接口、union 和负字段；其余公开配置、消息、结果和 Context 合同保持 |
| Driver agent-driver-v2 | 直接顺序 getContext；路由只绑定 Context executor；不动 Map、门禁、消息和调度 |
| SystemPrompt Source | 单条 system/static/0 消息及空 tools；无假执行器；读取失败局部诊断和降级 |
| Host Source | 复用 Driver 类型；消息/工具/执行一次捕获；闭包固定 topic，执行前身份检查 |
| MCP Source | 删除跨轮 toolsCache；Context 局部保存原函数/receiver；实时控制和原映射保留 |
| Skill Source | 捕获当轮 catalog；删除占位 executor；原读取、控制、缺参、未知技能、异常和通知保留 |
| IM Source | 原消息捕获和工具组装进入 Context；原 compaction 由 private 方法承接；历史算法不改 |
| IM types | 仅删除一个无人消费的必填 getMessages，未补 getContext 或可选兼容字段 |
| MCP index | 仅 Tool/jsonSchema 来源与 dynamicTool 等价对象构造；Schema、execute 闭包、client.callTool 参数和 timeout 原样 |
| HostManager / SessionManager | 各只删除一处 `mcpDrivenSource as any`；callbacks 和 Batch 07 通知未改 |

没有新增生产文件、状态字段、依赖、管理器、队列、计时器、公共开关或兼容层。剩余 Context 执行闭包、MCP 的局部函数表和既有 Source 控制状态分别承担本轮身份与实时资格责任，不是另一套跨轮缓存。

测试迁移保留消息、门禁、排序、Map、this、错误和释放断言。旧 split 专属入口改为真实 Context/Driver 主链；新 Skill 文件覆盖真实 Source。基线过时的 SessionManager fixture 改用当前 ensureSession/desktop 装配、受控外部资源和真实 Host Source/Driver；补齐原 fixture 的 DB 方法、正确 GUI user 事件筛选及既有 region 期望。未修改生产通知或制造手工续轮。IM 续跑测试只改必要 Source 接入和 call-through spy，不补第二次 trigger。

README 说明唯一 Context 接入、捕获/执行/释放持有期、失败边界、身份守卫和旧接口迁移，示例采用当前 Semantic adapter。D3 历史格式迁移已取消，不计后续工作或准出条件；message-service-v2、Runtime、SDK 和普通消息归一化未修改。

## 5. 基线失败、有效先红及处理中间失败

以下原始记录均保留，没有删除测试、降低断言或新增 skip：

| 记录 | 事实及处理 |
| --- | --- |
| `baseline-driver-tests` / `baseline-driver-strict` / `baseline-driver-build` | 5 文件 46 passed、1 项原有 skipped；严格检查及构建退出 0 |
| `baseline-host-tests` | 11 文件：7 passed、4 failed；74 passed、14 failed，含 SystemPrompt 错误相对导入导致的 suite failure。SessionManager 11 项旧构造/API fixture 失败；compaction 2 项缺通知 mock；IM manager 1 项缺既有 region 期望。均在授权测试内修复/迁移，compaction 按额外授权处理 |
| `semantic-post-authorization` 的 reconstructed opening 阶段 | 用实际 preimage 和基线声明重建的 Host 测试严格 Program 有 **22 项诊断**。这是后重建证据，不是开工 live 命令；checker 退出 0 表示符合“原非零/现零”的断言，不能把原 22 项写成通过 |
| `baseline-identity-red-final` | 未改生产上 12 项中的 8 项按正确目标/门禁预期失败、4 项正常保持通过。失败来自实际错误目标或业务进入，而非类型/导入/依赖失败；旧调用最小 adapter 仅存在于证据，未进生产或最终永久测试 |
| 早期 identity 探针 | 早稿使用过错误 server key，已在未改生产上修正重跑。正式先红依据是 `*-red-final` 与对应完整结果，不用早稿控制键证明 server 门禁 |
| `driver-tests-after-fixture-migration` | 一项测试仍期待 Source this；改为断言已捕获的真实 Context this，再通过。未改变生产 this 合同 |
| `host-production-strict` / `sdk-boundary-proof` | 暴露占位 dynamicTool 的 execute 要求和跨包 Schema 类型冲突。三处已授权 Source 使用无占位 execute 的等价 dynamic 描述；工厂冲突按 revision 04 解决，未用 any/ts-ignore 掩盖 |
| SessionManager 两次中间回归 | 分别暴露旧 fixture 缺 persistDatabase，以及首个 GUI 事件其实为 agent_state；补齐受控 DB，等待实际 user 事件。保留原消息/隔离/清理断言 |
| `host-required-regression` | MCP 一项日志参数断言不正确，提前失败造成后续 mock 一次队列串扰和超时。保留失败记录；正确断言三项日志参数、每例 reset 外部 mock 后通过。该超时不计身份先红 |
| `host-strict-with-tests` | 两个既有 IM 测试导入少 `.js`，产生未解析导入及后续隐式类型诊断；改正导入后严格检查为 0，没有引入 any 或 suppression |
| `baseline-factory-declaration` | 在已迁移一部分图上尝试原工厂声明失败，输出 files 为空，不能称原件已保存。之后从开工源码和实际基线 Driver 声明重建完整严格图，输出真实 `.d.ts`/map，另标 `baseline-factory-reconstruction.json` |
| 负责人发现 SystemPrompt 隔离回归 | 合法 string getter 在某轮抛错，原 split 会省略该源，初版候选却中止整轮。负责人原始探针见 owner-review；执行者永久回归在未修初版上 **1 failed/11 passed**，健康源捕获 0；就地 catch 后 12 passed，健康源捕获 1、onRunError 0、原错误只诊断一次，下一次读取恢复；constructor/setter 错误仍抛出 |
| 首次封版 | 新观察到两份并行 Lead 交接文档，因尚未分类而停止封版；保存错误输出后将其归为只读负责人引用，未加入 patch，未更改文档内容 |
| patch 审计两次中间失败 | 第一次证据断言把 fixture 的十空格按八空格匹配，修正证据断言；第二次 whitespace 门禁指出迁移状态机 fixture 的 12 行带缩进空行和 MCP 测试末尾空行。仅整理已改 fixture/EOF 后，Driver 全量与严格检查重跑通过，最终 whitespace/重放通过 |

SystemPrompt 修复前源码/测试在 `before-prompt-review-fix/`，首个生成 patch 在 `candidate-before-whitespace.patch`（SHA `1cf56a6f4ee2a14d8e66287ad68eb93f8d5e3ba6755076aeeda5b24c6290ef1d`）。原始日志和早期声明保留；最终审计使用 `final-candidate-declarations/` 和本报告顶部指纹，不将初版候选当最终产物。

## 6. 最终验证与可观察证据

完整 cwd、argv、退出码、输入 SHA、stdout/stderr 路径和 SHA 集中在 `commands.json`，此处列关键实际运行。

| cwd / 实际命令或日志 label | 退出与数量 | 关键事实 |
| --- | --- | --- |
| Driver：`pnpm exec vitest run --no-cache --reporter=dot`（`post-format-driver-full`） | 0；5 文件 **46 passed、1 原有 skipped** | 单捕获、Context this、同名后源、Map 更新/skip、捕获失败/逆序释放、逐次 stop/禁用、真实 SDK 不自动执行、unknown/accepted、无自动业务重试 |
| Driver：`pnpm exec tsc --noEmit --project tsconfig.json`、`pnpm build` | 均 0；`driver-strict-after-migration` / `driver-build-after-migration` | 当前生产构建；之后 Driver 生产未变化 |
| Driver 五测试文件严格语义检查（`post-format-driver-tests-strict`） | 0 | 使用 ES2022/bundler、strict、原 skipLibCheck |
| Host：任务书 §5E 十二个文件的完整命令（`post-review-host-regression`） | 0；12 文件 **130 passed** | 五个真实 Source；MCP 原函数/this/实时控制；Host 旧 topic 优先拒绝；历史加载/恢复；真实 Host→IMSessionManager→IM Source→Driver 的通知与释放 |
| Host 生产入口及全部改动测试严格检查（`post-review-host-strict`） | 0 | 所有修改入口和 IM 管理器均纳入；未降级原严格选项 |
| 同原 tsconfig 的实际 IM/Host manager Program | 均 0 | 对应先前 TS2741，以及工厂 TS2322/TS2589 的实际链消失；见 `semantic-post-authorization.json` |
| Runtime：两个 Semantic adapter 测试（`runtime-atomic-adapters`） | 0；2 文件 **42 passed** | 既有原子 adapter 与真实 Core 正向兼容；当前 Driver 构建 |
| identity 候选（`identity-green`） | 0；12 passed | 8 项身份差异逐一为批准的新预期，4 项正常完整记录相等 |
| 实际 MCP.tools 工厂前后对照（`factory-runtime-equivalence`） | 0；3 passed | 仅替换 Config/Instance 所持受控客户端；真实旧/新 MCP.tools 和工厂。dynamic、字段顺序、description、Schema 全量相等；同一 client/Schema、调用参数和 timeout、每次一个业务效果、返回/抛错保持 |
| 真实包正向类型 / Runtime adapter 类型 / 运行消费 | 均 0 | tarball 解包入口，Context 正向、实际 trigger 捕获和 release，无网络 |
| 真实包 split-only 负类型 | **预期退出 2，TS2741** | 缺必需 getContext，旧 split 对象不能接入；不是失败掩盖或 skip |
| 严格语义声明及合同审计 | 0 | 12 份完整 baseline/candidate 声明，两个 Host manager `.d.ts` 字节一致；其他差异只在授权退出/私有承接/Tool 来源 |
| 隔离 patch 门禁（`patch-gates-final`） | 0 | 正向等于 25 路径候选，反向恢复实际 preimage、新测试退出；live reverse check、whitespace、HEAD/index 与依赖控制通过 |

三组正式回归共 **218 项执行通过，另 1 项原有 skipped**；不将重复运行、探针或 skipped 叠加为更多业务测试。真实 MCP SDK 两个用例只替换 provider 创建边界，经过真实 Driver、LLMClient.call 和 streamText；其他门禁测试的模型响应边界受控。外部 MCP/Skill/DB/Runtime 资源按测试职责使用受控边界，没有触达真实外部副作用。

### 完整输出比较

`output-comparison.json` 保留 8 项身份差异的双方完整记录。正常 MCP 字符串、对象、效果后抛错，以及 Host 正常 compaction 四份记录比较全部字段相等，没有仅比较 status、删详情或归一化错误。

IM 开工主链从已保存的实际源码重建，原有 10 场景再运行通过，未回滚 live 文件；输入来源在 `baseline-reconstruction-inputs.json`。最终候选完整 IM 轨迹 **96,712 字节逐字节一致**，包含完整模型 messages、call/result、执行次数、通知/释放顺序、pending 前提与 600ms 安静窗口。除 stop 场景一轮外，均为两次模型调用，pending 场景在释放迟到 handler 前为 true；最终 assistant 与在途结算后完整推进安静窗口，没有第三次调用或手工续轮。

该 IM 记录的工具部分记录 tool names，**不声称其中含完整 Tool 描述**。描述/Schema 另由三个 Source 的精确表达式/常量审计、Driver 保留对象引用/SDK 元数据测试，以及真实 MCP 工厂对照覆盖；见 `declaration-audit.json`、`factory-equivalence.json`。

### 声明原件与来源

11 份基线声明在生产修改前，以真实严格语义 Program 生成；新增工厂的一份在 revision 04 后由保存的原件与基线 Driver 声明重建。12 份完整基线 `.d.ts` 和对应 Host `.d.ts.map` 均实际存在并进入最终 manifest；12 份最终候选同样实际存在，不只有哈希。

AST/全文审计确认：ToolResult、LLMConfig、消息、Context 及其余 Driver 配置不变；HostManager/SessionManager 公共声明字节相同；五 Source 只退出 split 并增加 getContext/必要 private 承接；IM 管理接口只删一项；MCP namespace 除 Tool import 来源外全文相同。Source map 的位置变化另保留，不当成公共字段变化。没有输出新公共 helper 或类型绕过。

## 7. 自审、已知例外和未执行项

- 旧 split、跨轮 MCP toolsCache、Source executor fallback、Host 临时接口和占位 executor 已退出；单一 Context 接入，没有隐藏兼容 adapter。证据中的基线 adapter 不进入生产。
- Scope/Observation/ledger、SDK validator/Ref/ToolUI、Driver 全局 Map 清理、消息协议、Runtime/SDK 包与依赖均未改。D3 已取消，不留作后续待办。
- 普通 atomic 捕获失败仍终止、后源不捕获、逆序 release；迁移来源自己的捕获失败诊断后降级。handler 在途完成后才释放的原行为保持。
- MCP 实时禁用、Host topic 不匹配属于未进入业务的拒绝；未知/accepted/效果不确定仍诚实保留，不自动重试。catalog/客户端外部业务状态及 A→B→A 永久撤销不在本批扩展范围。
- **保留一个已知旧例外：** MCP 业务成功后，若 onUpdate 的某位订阅者首次抛错，原实现与候选均业务执行 1 次、健康订阅者收到 2 次，结果为 `Error: subscriber unavailable`。负责人以两版真实 Source 证据确认，项目所有者明确“本批保留旧异常行为，登记缺陷后单独处理”。本批未修此路径；引用 `owner-review/opening-mcp-subscriber.log` 和 `initial-mcp-subscriber.log`，不把它们列为执行者测试。不以“每个通知异常也恰好一次”概括现状。Batch 10 任务书由负责人另管，不入本批 patch。
- 963 份历史原件已丢失；保留开工指纹、观察时序和所有者处置，无法复核已不在场的原件。没有恢复历史或把损失写成保全成功。
- 未运行 Host/Runtime/SDK 全量、Electron/GUI、真实网络模型或外部 MCP、性能矩阵、项目所有者完整 Semantic 验收。它们不在本批默认准出范围，未写为通过；原有 skip 未执行且未计入 passed。

没有创建提交、push、merge、发布或自行批准。正式交付索引为 `review-evidence/minimal-core-batch-09/README.zh-CN.md`，封版清单为该目录的 `final-delivery.json`。
