# SDK / Runtime 核心清理：2026-11-01

> 后续变更（2026-11-03）：本文保留 11 月 1 日清理批次的历史判断。项目所有者随后授权清理重复结果和通用任务查询机制；当前已移除 `ActionOutcome`、`OperationProvider` / `TaskProgressProvider` 与 `readReceipt`，公共示例已迁移到 `ToolResult`。Ref 和 Ref Tool 按所有者最新要求继续保留。当前调用合同见 [Semantic Host 接入](semantic-host-integration.zh-CN.md#4-receipt-描述调用事实不承诺持久查询或跨轮-exactly-once)。

这是第一轮的历史交付记录。后续删除项及其验证见 [第二轮清理记录](core-cleanup-pass2-2026-11-01.zh-CN.md)；例如第一轮保留的 `useAppEnv` 已在第二轮收敛。

## 基线与范围

项目所有者要求：先分批提交当前改动，再审查并删除废弃、未使用和可有可无的代码；实现交给 GPT-6 Luna Max，主代理负责范围判断和质量审核。

原工作区已提交为四批，提交后工作区干净：

| 提交 | 内容 |
| --- | --- |
| `c1a21d219aee7073ad94bad995c5ec3eb3f71547` | Runtime / SDK Semantic 收敛与既有审核修复 |
| `8a4d210d2be8c29f9e7466bb5beca2eb2b677ddb` | 示例应用及脚本迁移 |
| `a040de0b2dd7d3f66c8b82eabec1580cc949a6be` | Host 集成及当前修复 |
| `bbcea40147e34956e5ff2b9b2ea2b4ac91dbcd12` | 过时文档删除及开发指导更新 |

本轮从 `bbcea40147e34956e5ff2b9b2ea2b4ac91dbcd12` 开始。聚焦 SDK / Runtime，调用方只做必要迁移。允许删除公共兼容入口；不引入替代框架，不恢复 Legacy。静态查找、类型检查和三个独立只读审查已用于确认消费者；下表是实施清单，不代表已经完成或通过测试。

## 删除与简化清单

| ID | 修改 | 迁移与保留要求 | 责任组 |
| --- | --- | --- | --- |
| S01 | 删除 `escapeHtml` / `escapeJsonForAttr`、未用参数验证结果类型 | 删除仅验证这些 helper 的测试及导出文档 | SDK |
| S02 | 删除 `defineParams` | 示例、fixture 改为内联参数或有类型的常量；保留 Runtime 参数合同检查和推断测试 | SDK |
| S03 | RefHandle 收敛为 formatter，删除 `.data` / `.id` 与无效泛型 | 验证真实 Hook 注册、标记输出和释放 | SDK |
| S04 | 数组 Ref 只注册实际输出的一种 ID，删除双份别名和重复跟踪 | 保留 itemType；迁移 Planning 解析器；验证重排、类型切换、卸载及注册失败清理 | SDK |
| S05 | 删除 `data-view-generation`、公开元数据中的内部 mount 字段 | 内部绑定生命周期所需 generation 保留在 SDK 内部；Runtime View 实例身份保留 | SDK |
| S06 | 删除无发送方的 `View.onClose` / `aotui:view-close` 监听 | 应用通过自身 Tool 更新 View 集合；保留卸载时绑定失效与资源清理验证 | SDK |
| S07 | 删除 SDK 工厂旧 `description`、`useAppConfig` 包装 | 使用 whatItIs/whenToUse；保留 useAppEnv 和 launchConfig；不删除 Host 的真实描述字段 | SDK |
| S08 | 删除组件/Hook 便利 barrel、内部 Preact 重导层、未发布的旧 JSX 属性声明 | SDK 根入口保留真实 Hook API；直接引用 preact/hooks；校验外部类型与单一 Preact 解析 | SDK |
| S09 | 删除手工模拟 Hook 的测试及无消费者的旧 IDE fixture，修正过时示例 | 正反行为迁到真实 Hook 测试；ide-read-slice 已无调用方，且引用的 FileDetailContent 已删除 | SDK |
| S10 | 删除 commit coordinator 的旧 Runtime 可选回退 | 唯一生产 RuntimeContext 始终提供 projection；SPI 改为必需，SDK 保留完整 begin/end 提交配对 | SDK / Runtime |
| R01 | 删除 createKernel 包装工厂和内部孤儿 barrel | createRuntime 直接构造 Kernel；公开包入口保留 | Runtime |
| R02 | 删除通用旧 Worker 接口与无消费者消息类型 | RequestID / generateRequestId 放回实际协议模块；实际 IPC 消息与身份检查保留 | Runtime |
| R03 | 删除 AppKernel 未用方法、Ref 转发别名和空生命周期 override | SDK Ref 注册及可选应用生命周期派发保留 | Runtime |
| R04 | 删除旧 `aotui:system` → `dismount_view` DOM 事件链 | 与 S06 配套；Agent 的 Semantic 应用生命周期工具保留 | Runtime |
| R05 | 删除 Transformer 空 context、未用 appId、重复类型和无消费者 helper | 保留实际 Markdown 转换、列表递归及 View 内容语义 | Runtime |
| R06 | 删除无生产 Producer 的 application Visitor | App 包络由 Semantic Source 负责；普通元素中的内容继续正常转换 | Runtime |
| R07 | 删除 Fragment timestamp/digest 缓存和 clear 包装 | 保留 Semantic 消息时间戳、快照 capturedAt；嵌套 View 整体拒绝保持不变 | Runtime |
| R08 | 删除 Manager 的批量关闭/删除/同步 cleanup 包装及测试专用池转发 | 使用 beginClose / cleanupAsync / beginShutdown；迁移有价值的关闭与未释放资源断言 | Runtime |
| R09 | 删除旧 destroy 仓储入口；清理实际关闭失败中的 legacy 命名 | 接纳点实例校验及真实失败报告保留，不能将失败改成成功 | Runtime |
| R10 | 删除 system: 特判和无消费者 manifest schema / validator / isValidAppName | 保留实际 aoapp.json entry.main 解析、现有工厂 appName 来源与非空检查及加载；不为保留 helper 新增格式机制，不承诺未执行的版本限制 | Runtime |
| R11 | 配置只保留 defineRuntimeConfig 的接纳校验 | 内部 validator 不是真实公共入口；消除二次 descriptor 捕获，保留 getter 零执行、未知字段拒绝、准确路径及数值规则；修复已复现的嵌套默认对象共享可写、导致后续配置被污染的问题 | Runtime |
| R12 | 删除无消费者 ID guards、错误 helper 和未用错误注册项 | 保留实际使用的 AOTUIError 与各边界错误；不按同名字符串误删 Core issue code | Runtime |
| R13 | Runtime 的 Preact 移到开发依赖；删除未用变量和导入 | SDK peer 与应用直接依赖保留；以新包消费证明依赖完整 | Runtime |
| R14 | 删除 AppRegistry 本地目录入口的两份相同解析代码 | loadFactory 的 local 分支复用现有 resolveModulePath，保留各自 npm 支持边界及实际 aoapp/package 入口行为 | Runtime |
| C01 | 删除 AppSnapshot 同义 alias、ViewOwnedTools / StateSession ReturnType alias | 统一 AppSnapshotV2；同步真实签名、类型测试、纯 TS 示例 | Core |
| C02 | 收回 SnapshotDraftEnvelope / SnapshotHealth 公共导出，删除内部 snapshot barrel | 内部失败来源跟踪、健康状态与直接导入保留 | Core |
| C03 | 删除 legacy-raw 存储解码回退 | 只接受正式 envelope；旧文件不改写、不删除，恢复报告不支持；合法 envelope 与业务 value 字段应正常工作 | Core |
| C04 | 删除 Memory storage 恒零统计和未使用导入 | 保留 owner / namespace / I/O 资源隔离与未知结果语义 | Core |

所有组必须同步删除项的当前文档、类型、精确导出断言和调用方；历史交付报告保留为历史事实，不改写成当前验收。

## 明确保留的核心职责

- Core 的 Snapshot Store / Committer / Lifecycle、Scoped Interaction、View-owned Tools 与 StateSession，以及 DOM 和纯 TypeScript Producer 消费能力。
- 实例身份、来源绑定、参数合同、调用记录、容量、只读 Ref、发布通知、失败健康状态及资源关闭。`ActionOutcome` 与只读 entity Ref 有正式消费者合同，不能因名字或默认 DOM 不生成而判为遗留。
- 暂停/恢复和 Runtime env 注入有真实运行链路，保留。删除空包装不等于删除生命周期合同。
- 不同信任边界上的校验继续保留：Worker 发送前捕获、Host 接收验证、Core 提交验证各自有职责。
- R1–R5 修复保持：旧实例不能操作继任者、禁止嵌套 View、新绑定可调用、IPC 前 getter 零执行、无效配置不能悄悄受理。
- MEM-01 继续独立处理；本批不声称解决内存门槛，也不扩大到真实模型或 Electron 窗口验收。

## 验证与交付

先由各组运行相关定向测试，主代理审查差异和行为迁移，再运行 SDK / Runtime 类型、构建及完整测试。重建并打包后，在新目录安装实际 tar，验证公共类型、纯 TS Producer、SDK 动态 View/Tool/Ref、既有审核反例及关闭行为。

重点配对：旧绑定拒绝 / 新绑定成功；非法输入拒绝 / 合法输入可用；投影失败 / 修正后恢复；关闭失效 / 重开可用。测试数量减少必须对应已删除合同或已迁移断言，不能以删除正向用例掩盖永久拒绝。

## 执行结果

S01–S10、R01–R14、C01–C04 已由三位 GPT-6 Luna Max worker 实施，主代理检查消费者、合并边界和迁移后的行为，完成统一验证。源码修改期间没有恢复 Legacy，也没有新增兼容包或并行验证框架。

SDK / Runtime 生产源码和类型涉及 77 个路径，新增 284 行、删除 1924 行，净减少 1640 行；不包含测试、文档、锁文件、示例调用方，也不包含前面四个基线提交的历史大规模删除。

### 测试迁移与审核修正

| 删除或变更对象 | 保留的行为证据 |
| --- | --- |
| 转义 helper 与手工 Map/字符串“Hook 测试” | 删除只服务退出 API 的测试；真实 Hook 测试验证注册、输出、卸载及部分注册失败清理 |
| 数组 Ref 双别名、公开 View mount 元数据 | 真实 Worker M3 用明确事件触发 Ref-only 更新，验证版本推进、值从 A 到 B、正文不变；M4 从 Host 已接受快照验证 View 身份与 Tool target 一致及物理 Worker 重用后的新身份 |
| 旧 DOM 关闭监听与 Manager 包装 | 迁移到 renderer 恰好卸载一次、beginClose/cleanupAsync/beginShutdown、真实关闭报告；卸载失败、等待、已进入业务结果及未释放资源仍有断言 |
| 裸 JSON 存储回退 | 旧记录 UNSUPPORTED_FORMAT、原文保留、不自动写回；合法 envelope、业务 value 字段、迟到恢复及反序列化失败继续验证 |
| 旧 application Visitor、fragment 时间缓存 | 仅退出私有整 App DOM 转换；独立 View、普通嵌套组件、非法嵌套整体拒绝与恢复仍验证；消息排序与时间由 Semantic Source 维护 |
| 旧 installApp(html) 跳过用例与空集成骨架 | 删除从未运行的旧路径测试；实际 Worker、发布、隔离、生命周期测试继续运行，不把跳过用例算成通过 |

审查额外复现并修复了配置默认对象共享可写的问题。配置简化期间出现的 NaN 范围检查缺口也在交付前修正，现有三个数值字段均测试 NaN/越界拒绝和合法边界接受。SDK 根入口重写时漏掉的两个有效 LLM 输出 Hook 已补回。

首次 Runtime 全量的 6 项失败是三处旧合同断言未迁移：Ref 双别名计数、公开 viewInstanceId 字段、旧 DOM listener 清理。修订时保留相应身份、更新与资源行为，最终全量通过。初次日志保留，没有改写为成功。

### 最终验证范围

| 检查 | 结果 |
| --- | --- |
| Runtime 全量测试 | 126 个文件，2101 项通过，0 skipped / 0 todo |
| SDK 全量测试 | 15 个文件，156 项通过 |
| SDK 公共类型；SDK / Runtime noUnusedLocals + noUnusedParameters | 全部通过 |
| 构建 | Driver、Runtime、SDK、5 个示例 App、Host，共 9 个模块通过；最后的 Runtime 清理再次构建通过 |
| 新包身份 | 8 个 tar 在空目录离线安装，关闭安装脚本；748 个已安装文件逐一与 tar 比较一致，AOTUI 包均不是 symlink |
| 公共包消费 | ES2022-only 纯 TS Core 示例、Runtime/SPI/SDK/IDE 声明、严格参数推断、Semantic Context 与 release 合同通过 |
| 真实 IDE 消费 | 打开文件、编辑后读取最新 View、实际 LSP hover、managed shutdown 通过，resourcesReleased=true |
| R1–R5 反例 | 全部通过：仅 Agent 工具关闭/重开后的旧实例拒绝、嵌套 View 双层拒绝及恢复、新绑定成功、getter 零执行、无效配置及准确字段诊断 |
| 新存储与配置边界 | 裸对象/裸数字 JSON 拒绝且原文不变，正式 envelope 正常；默认配置不被污染，调用方输入未被冻住且不与结果共享可写对象 |
| Planning 实际调用方 | typed Plan/Task Ref 的打开与完成成功，下一 Context 更新；旧 bare ID 明确不成功，保留实际 unknown + PLAN_NOT_FOUND/TASK_NOT_FOUND 结果；关闭后页面和能力退出，resourcesReleased=true |
| Runtime 锁文件 | 仅将同版本 Preact importer 移到开发依赖；独立目录使用缓存的 pnpm 10.15.1 做 offline frozen-lockfile 检查通过，未安装依赖 |

Token Monitor 和 Planning 的根目录缺少完整本地构建依赖，因此使用当前源码的隔离副本、已有第三方工具与当前 SDK/Runtime 进行构建；没有声称重新安装过其全部开发依赖。第一次 QA 构建准备遇到历史临时目录中的失效可选链接，排除该链接后完成构建。初次外部 QA 脚本把 Core 的 null-prototype JSON 与普通对象做严格原型比较，以及给 Tool UI 使用了不匹配的 Preact h props，修正脚本后对应检查通过；生产实现没有因此放宽。

证据目录：`/private/tmp/aotui-core-cleanup-qa-rmfct119`。其中保存构建与测试日志、各命令退出码、新包哈希和安装文件身份、R1–R5 与真实 IDE 的事实记录、锁校验以及源码指纹。最终安装身份及复跑结果记录在 `consumer.json`、`packages.json` 和 `final-package-*` 中；只有成功的实际运行才计为交付证据。

MEM-01 没有重开或改成通过。完整 Host 测试套件、真实 LLM 和实际 Electron 窗口不在本次通过范围内；Host 只验证构建及上述 Runtime 包消费链路。
