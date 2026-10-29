# AOTUI 代码清理技术方案与执行任务

本轮目标是让 Runtime 和 SDK 的现有实现更容易理解，并保证删除源码后，测试和构建产物能够如实反映变化。采用小范围、可独立验收的清理方式，保持公共接口与运行时行为稳定。

协作方式：负责人制定方案、处理边界决策并验收；用户分配任务；执行 Agent 按文件所有权实施并提交证据。C00 至 C04 已执行，并于 2026 年 10 月 7 日通过 C05 验收。以下任务定义和初始基线保留作为本轮验收依据，最终结论见文末的 C05 验收记录。

**技术方案与取舍**

| 方案 | 收益 | 代价 | 选择 |
| --- | --- | --- | --- |
| 按证据分批清理，每批保持接口和行为稳定 | 容易审查、回滚和定位回归，可以持续推进 | 暂时保留需要兼容性决策的旧接口 | 推荐 |
| 按目录集中整理，同时拆分大文件和统一风格 | 文件外观和布局更统一 | 改动面大，移动、格式化和行为变化容易混在一起 | 留到职责边界确认后 |
| 集中删除兼容层并重做 API | 可以明显缩小接口面 | 需要消费方迁移，属于框架升级 | 单独设计，不纳入本轮 |

本轮清理分成四类：删除能够证明无用的内部代码；让 SDK 单元测试读取当前源码；让构建从干净的输出目录开始；修正过期示例，并为兼容接口建立去留依据。

“编译器报告未使用”只是线索。删除前还要检查公共导出、调用方和副作用。例如，读取 Signal 的值可以建立订阅，即便接收这个值的局部变量没有再被使用，也不能把读取动作一起删除。

**共同基线**

基线记录日期为 2026 年 10 月 7 日。仓库位置为 [AgentOrientedTUI](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI)。当前 HEAD 为 `789ef07cb18084d97b0476c1ffc234ae0b9319f0`，其上还有第一轮清理的 42 个已跟踪文件改动，尚未提交。因此，单独检出这个 HEAD 不包含第一轮清理。

第一轮已经删除旧全局 Ref 注册器、14 个孤立的声明映射文件、未使用的导入和辅助函数，以及部分调试残留。合计新增 20 行、删除 448 行，净减少 428 行。这些工作不需要重复执行。

| 已有验证 | 结果 |
| --- | --- |
| Runtime 构建和测试 | 构建通过；44 个测试文件，380 项通过、3 项跳过、7 项待实现 |
| SDK 构建和测试 | 构建通过；7 个测试文件，64 项通过 |
| Agent Driver 构建和测试 | 构建通过；3 个测试文件，19 项通过、1 项跳过 |
| 公共接口核对 | 对比编译声明，公共导出和签名保持一致 |
| 差异格式检查 | `git diff --check` 通过 |

上述测试基于当前本地依赖，共 463 项通过。它们不代表干净安装、Electron GUI 或真实模型任务已经验证。

第一轮之后的诊断：启用 `noUnusedLocals` 和 `noUnusedParameters` 进行只读扫描，Runtime 还有 23 条诊断，SDK 还有 4 条，Driver 为 0。这些诊断包含公共参数、泛型和注入点，本轮不以全部归零为目标，也不修改 tsconfig 来强制归零。

两个需要补上的工程问题已经确认：

- [SDK 测试配置](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/vitest.config.ts) 把参数校验测试的源码导入映射到了 `dist`。测试可能验证旧产物。
- 三个核心包当前都直接执行 `tsc`，不会先清理输出目录。已经删除的 Ref 注册器仍留有 `sdk/dist/ref-registry.js`、`.js.map`、`.d.ts`、`.d.ts.map` 四个旧产物。

**本轮边界**

公共导出、构造参数、工具名称、错误码、快照格式、Ref 解析规则、生命周期和持久化行为保持稳定。活动日志可能被开发者用于调试，本轮只清理已经注释掉的日志及其空分支。

不升级依赖，不重排 workspace，不引入清理插件、统一日志框架或新的抽象层。Host 和 Demo Apps 用作调用方检查范围，不作为本轮改造范围。此前发现的业务失败包装、跨视图 Ref 解析、位置引用和 usage 字段问题分别登记为功能修复，不能夹带在清理任务中。

每个删除项都应能回答：它是否属于公共契约，当前调用方在哪里，初始化或读取是否有副作用，哪项验证证明主要行为未受影响。无关格式化和批量改名不进入任务差异。

**任务分配与顺序**

| 任务 | 建议执行者 | 交付物 | 前置条件 |
| --- | --- | --- | --- |
| C00 固定共同基线 | 集成 Agent | 基线提交或等价补丁及基线标识 | 分发前完成 |
| C01 清理剩余内部无效代码 | Runtime Agent | 限定的 5 个文件差异及验证结果 | C00 |
| C02 修正 SDK 测试入口 | 测试 Agent | 测试配置差异及无 SDK dist 的测试结果 | C00 |
| C03 清理构建产物 | 构建 Agent | 3 个包的构建脚本差异及产物验证结果 | C02 纳入执行基线 |
| C04 修正示例并盘点兼容接口 | SDK Agent | 两个入口文件的注释修改及兼容性报告 | C00 |
| C05 汇总验收 | 负责人 | 通过、需返工或待设计的明确结论 | C01 至 C04 汇报完成 |

C01、C02、C04 可以并行；C03 在 C02 完成后执行，避免清理 SDK dist 时旧测试入口失效。若所有 Agent 共用一个工作目录，构建、移动 dist 和完整测试必须串行，防止一个 Agent 删除另一个 Agent 正在使用的产物。独立工作目录也必须从包含第一轮清理的共同基线开始。

**C00 固定共同基线**

集成 Agent 先检查当前工作树。推荐将已验证的第一轮清理单独提交，再从该提交分发任务；如果不采用提交，应提供等价补丁，使每个执行环境具有相同内容。不要从旧 HEAD 或远程默认分支直接开始。

只纳入已经确认的 42 个已跟踪文件改动，不使用 `git add .` 混入无关文件。当前未跟踪的 `.agents/`、`skills-lock.json` 和评估文档各自保留。本任务书作为协作文档单独处理。

交付：共同基线的提交号或补丁标识、第一轮差异摘要、依赖是否复用当前本地安装，以及每个任务实际使用的工作目录。没有源代码变化或环境变化时，可以引用已完成的基线测试，不必重复运行。

**C01 清理剩余内部无效代码**

文件所有权仅限以下五个文件：

- [AOTUI 来源适配器](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/adapters/aotui-driven-source.ts)
- [AppManager](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/app/manager.ts)
- [WorkerPool](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/app/worker-pool.ts)
- [ViewLink Visitor](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/transformer/visitors/view-link.visitor.ts)
- [错误消息格式化](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/spi/core/errors.ts)

具体工作：

1. 删除私有方法 `resolveClassicToolContext` 未使用的 `toolName` 参数，同步调整当前调用点。保留工具解析和路由条件。
2. 将 `broadcastLLMOutput` 中只使用 worker 的 Map 遍历改成遍历 `values()`，保持广播顺序和参数一致。
3. 删除 Worker `exit` 回调未使用的 `code` 形参，保持事件处理逻辑。
4. 删除 ViewLink 转换中未使用的 `viewType` 局部变量，保持两类链接输出和描述拼接一致。
5. 删除 `VIEW_ROOT_EXISTS` 消息格式化回调未使用的形参，保持消息文本和错误码一致。

不扩大到整个 Visitor 接口的形参整理，不改公开类型，不删除依赖注入点。不为消除诊断增加 `any`、`ts-ignore` 或虚假的变量读取。

验收：Runtime 构建和原有 380 项测试通过；上述 5 处诊断消失；公开声明不变，私有辅助方法的参数删除单独列出；差异仅包含这五个清理项。其余诊断列入保留清单即可。

**C02 修正 SDK 测试入口**

文件所有权：[sdk/vitest.config.ts](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/vitest.config.ts)。

删除将 `../../src/utils/validateArgs.js` 映射到 `dist/utils/validateArgs.js` 的别名，并清理因此不再需要的 `resolve` 导入。使用 Vitest 现有的 TypeScript 模块解析能力。保留 jsdom、Preact JSX 和其他现有设置。

验证时临时隔离 SDK 自己的 dist，在测试结束后恢复原有目录或重建。Runtime 和 Driver 的包间依赖产物可以预先构建；本任务只承诺 SDK 的单元测试不再依赖 SDK 自己的旧 dist。

验收：SDK dist 缺失时，现有 7 个测试文件、64 项测试仍通过；参数校验测试确实解析到源码；不删除或弱化断言，不新增 skip，不调整校验行为。无需增加新的测试框架或永久验证脚本。

**C03 清理构建产物**

文件所有权仅限三个包的构建脚本：

- [runtime/package.json](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/package.json)
- [sdk/package.json](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/package.json)
- [agent-driver-v2/package.json](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/agent-driver-v2/package.json)

在现有 `build` 的 TypeScript 编译之前，使用 Node 自带的文件系统 API 清理当前包的 dist。推荐直接在包脚本中调用 `rmSync('dist', { recursive: true, force: true })`，不增加依赖或公共清理模块。

只操作当前包的 dist；保留 Runtime 原有 CLI 可执行权限设置，保留三个包现有 exports、files、版本和依赖声明。该任务允许改动忽略的构建输出，但不提交它们。

验收步骤：

1. 在每个包的 dist 中创建一个临时哨兵文件，然后按 Driver、Runtime、SDK 顺序执行构建，确认哨兵均被删除。
2. 确认已删除的 SDK Ref 注册器四个产物均不再存在。
3. 在产物存在和产物不存在两种状态下确认构建均能成功。
4. 确认既有入口 JS 和声明文件正常生成，Runtime CLI 仍具备执行权限；源码目录没有重新生成声明映射文件。
5. 比较构建前后公共类型声明，忽略注释、映射位置以及已经说明的内部删除。构建脚本本身不能引入 API 差异。

此处验证针对已安装依赖的干净输出构建，不等同于全新机器上的安装和发布验证。不要通过安装新包或改 workspace 来扩大任务。

**C04 修正示例并盘点兼容接口**

可修改的源文件只限注释：

- [SDK 入口](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/index.ts)
- [Runtime Facades 入口](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/facades/index.ts)

另交付一份仓库根目录的 `CODE_CLEANUP_COMPATIBILITY.zh-CN.md`，用于记录需要负责人决策的项目。

具体工作：

1. 修正仍推荐导入 `ViewBasedApp`、`List`、`Item`、`Operation` 等旧名称的示例，使用 SDK 当前真实导出的 API。不能为了让旧示例成立而重新增加导出。
2. 修正 SDK 顶部完整示例的重复标注和可执行性问题：声明明确的列表元素类型；工具 Hook 放在 View 的子组件内；View 类型与工具注册类型一致；按当前工具契约传入 `view_id`。示例可以缩小到一个最小可用场景。
3. 用当前 SDK 配置对完整示例做严格类型检查，并实际挂载验证 Hook 上下文；使用现有测试环境或临时验证文件即可，不新增演示应用或测试框架。
4. 对下表中的项目核查导出路径、源码调用方、测试调用方和副作用，仅记录结论，不删除或实现它们。

| 盘点对象 | 当前线索 | 必须回答的问题 |
| --- | --- | --- |
| [Desktop.appHostService](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/core/desktop.ts) | 保存注入值但没有读取；构造选项仍存在 | 它是否承载兼容承诺，哪些入口仍接受该选项 |
| [SnapshotBuilder.transformer](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/snapshot/builder.ts) | 字段未读取，构造函数可能创建 Transformer | 构造有无副作用，Builder 还由谁调用，是否有完整替代路径 |
| [SnapshotFormatter.appLogLimit](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/snapshot/formatter.ts) | 配置和字段存在，但未参与格式化 | 属于未兑现配置还是可废弃字段，删除和补实现分别影响什么 |
| [Kernel.transformer](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/kernel/index.ts) | 构造注入但字段未读取 | 公共构造函数与工厂调用如何兼容 |
| [ViewManager](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/manager.ts) | 部分方法是兼容性的空操作 | 注入方、生命周期委托和测试是否仍依赖它 |
| [ArrayRefHandle 的泛型](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/useArrayRef.ts) | 类型参数没有参与元组，但类型对外导出 | 现有消费方是否使用显式类型实参 |
| [LLMOutputChannel options](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/useLLMOutputChannel.ts) | 参数未读取，仍声明 includeHistory | 实际行为、文档承诺与消费方预期分别是什么 |
| [SignalStore 局部变量](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/useSignalStore.ts) | 接收值的变量未使用，读取本身用于订阅 | 是否可仅移除绑定并保留读取，如何避免破坏响应式行为 |

报告逐项给出“保留”“可在下一轮删除”“需要另开功能或兼容性设计”之一，并附源码位置和判断依据。没有仓库内调用方，不足以证明一个公共 API 没有外部使用者。

验收：两份入口源码的可执行逻辑和导出保持不变；示例的导入、类型、View 上下文能够验证；兼容性报告覆盖上述八项，并区分已证实事实与待确认假设。

**交给每个执行 Agent 的共同说明**

将下面的说明连同所分配任务一起发送：

> 请执行本任务书中的指定任务，并遵守 minimalist 原则。你不是唯一在代码库工作的 Agent；保留既有清理和其他人的修改，只编辑分配给你的文件。开始前核对共同基线与工作树状态，发现任务已被完成时先核对结果，不重复改写。新增需求或需要跨文件所有权的修改列入汇报，继续完成不受影响的部分。一个任务提交一份独立差异或提交记录。完成后按汇报模板交付，由用户转交负责人验收。

**执行汇报模板**

```text
任务编号：
执行基线：提交号或补丁标识
交付位置：工作目录、分支和提交号，或可查看的差异
修改文件：
具体改动：
删除或保留的依据：导出、调用方、副作用
公共接口与行为：是否变化，依据是什么
验证命令及结果：通过数、跳过数、待实现数、退出码
任务专项验证：例如无 SDK dist 测试、旧产物消失、示例挂载
未完成项与需要负责人判断的项目：
```

**负责人验收方式**

先检查实际差异与任务边界，再核对删除依据和公共声明，最后执行必要验证。Agent 自述完成或单独提供“测试通过”不能代替代码审查。与任务无关的格式化、接口调整、功能修复或测试弱化需要拆出。

所有任务集成后，在仓库根目录按顺序执行以下命令。先完成依赖构建，再运行测试；同一份 dist 不与其他 Agent 的清理操作并发使用。

```sh
pnpm --dir agent-driver-v2 build
pnpm --dir runtime build
pnpm --dir sdk build
pnpm --dir runtime exec vitest run
pnpm --dir sdk exec vitest run
pnpm --dir agent-driver-v2 exec vitest run
git diff --check
```

原有 463 项通过用例必须继续通过，不能新增跳过或待实现项来降低验证范围。构建已经包含严格 TypeScript 检查，无需重复增加等价的全量检查。C02、C03 和 C04 的专项证据分别核对，不将现有测试数量当作这些专项条件的替代证明。

验收结论逐任务给出：通过；需返工，列出具体文件和原因；或已完成当前清理但另有兼容性设计待定。C04 中待设计项目不会阻塞其他已完成任务，也不会自动获得删除公共接口的授权。

**C05 验收记录**

验收日期：2026 年 10 月 7 日。结论：C00、C01、C02、C03、C04 全部通过，本轮清理完成。没有发现需要返工的缺陷。此结论基于实际增量审查、工作树核对和独立运行的验证。

| 任务 | 验收结论 | 核对结果 |
| --- | --- | --- |
| C00 | 通过 | 初始补丁、文件哈希和声明基线可用；独立核对确认第一轮清理、原有未跟踪文件、HEAD 和暂存区得到保留 |
| C01 | 通过 | 五处清理与任务一致；参数路由、Map 广播顺序、退出事件处理、ViewLink 输出和错误消息未发现行为变化 |
| C02 | 通过 | 独立隔离 SDK dist 后，7 个测试文件、64 项测试通过；解析日志确认 validateArgs 来自源码 |
| C03 | 通过 | 独立重建三个包，临时哨兵均消失；旧 Ref 注册器四个产物不存在，入口及 Runtime CLI 权限正常；另核查执行方提供的 dist 缺失构建证据 |
| C04 | 通过 | 两个入口仅修改注释；从当前源码重新提取示例，严格类型检查与真实 AppKernel 挂载均通过；八项兼容性盘点与已检查实现相符 |

独立回归结果：Runtime 380 项通过、3 项跳过、7 项待实现；SDK 64 项通过；Driver 19 项通过、1 项跳过。合计原有 463 项通过、4 项跳过、7 项待实现。文档示例挂载另有 1 项临时验证通过，不混入原有测试数量。验证结束后临时仓库文件已清理，源码文件没有被验收过程修改。

接口复核采用 TypeScript 语法树规范化后比较：当前构建的 Driver 8 份、Runtime 132 份、SDK 28 份声明，共 168 份，与执行前源码生成的声明一致。两个入口的非注释代码一致；三个 package.json 除 scripts.build 外结构一致。首次直接扫描 token 的辅助比较未正确处理模板字面量，产生注释差异误报；改用语法树后通过，期间未修改产品代码。

独立范围审计确认，本轮执行仅改变授权的 11 个已有文件，并新增兼容性报告；增量补丁与实际工作树匹配。C05 完成后仅在本任务书登记状态和验收结论。

兼容性决策：本轮继续保留八项盘点对象。Kernel 构造参数、ViewManager 委托方法和 ArrayRefHandle 泛型维持兼容；SnapshotBuilder 的未读字段及 SignalStore 局部绑定可以作为下一轮小范围清理候选，但需保留构造参数与订阅读取；appHostService、appLogLimit 和 includeHistory 的实现或弃用另行设计，不作为本轮遗留缺陷要求补做。

证据入口：[执行方交付报告](/private/tmp/aotui-cleanup-20261007-af1iknu4/ACCEPTANCE_REPORT.zh-CN.md)、[本轮增量补丁](/private/tmp/aotui-cleanup-20261007-af1iknu4/incremental.patch)、[独立验证命令与退出结果](/private/tmp/aotui-c05-review-pqcwaihc/commands.json)、[专项复核结果](/private/tmp/aotui-c05-review-pqcwaihc/checks.json)、[声明与入口比较结果](/private/tmp/aotui-c05-review-pqcwaihc/api-check.json)、[兼容性报告](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/CODE_CLEANUP_COMPATIBILITY.zh-CN.md)。

验收范围为本地已安装依赖下的构建、现有回归、专项验证和代码审查。未执行干净安装、发布、Electron GUI 或真实模型任务，不据此作出这些范围的质量结论。既有独立功能问题维持原有处理范围。
