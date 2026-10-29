# SDK / Runtime Semantic 清理实施记录

本记录对应根目录两份原始清理附件和 Goal 目标。原附件保持原样；53 项原始任务与 I01–I20 的逐项状态保存在 [progress.json](progress.json)。这里记录实际执行事实，不替代原计划范围。

## 当前边界

- 已保存 C00 源码基线，并执行 C01 的独立清理。
- G1 仍缺项目所有者本人的 Semantic 验收声明。此前已询问，收到的回复只补齐了附件路径。
- C02–C10 的完整范围继续保留。生产 Legacy、Fragment 通知来源、type-wide、旧工具传输及生命周期 fallback 尚未下线。
- 没有运行真实模型、读取用户凭据、提交、推送或发布 npm 包。

G1 来自 Goal 目标第 4 节及 AGENTS.md 第六节。现有自动化结果和历史签署不代替该事实；不因本轮存在新 tar 就认定产品退出门槛通过。

## C00 基线与环境

- HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`，原工作树有大量暂存、未暂存和未跟踪改动。
- [baseline/summary.json](baseline/summary.json)：保存全部暂存/未暂存二进制补丁，以及 935 个当前源码、测试、配置、清单和文档文件，其中 283 个原为未跟踪文件。
- [baseline/manifest.json](baseline/manifest.json)：逐文件 SHA-256、原跟踪状态、范围与排除项。压缩包已逐成员读回并与本机源码核对。
- 原始计划与任务索引保存在 `baseline/inputs/`。Markdown SHA-256 为 `d83c6d5122e882f30ca96e3d811b5b4a9ceddee7a659e86c5b20743bb48017e8`，与原 JSON 匹配。
- 历史交付目录、node_modules、dist、用户数据及凭据不在源码压缩包内。历史交付文件仅被现有兼容测试只读使用，没有删除或改写。
- 验证在从此基线重建的隔离源码副本运行；第三方依赖复用现有安装，`@aotui` 包指向该副本的新构建。[环境身份](evidence/worktree.json)明确说明其范围。
- Token Monitor 原目录缺 node_modules。隔离副本显式复用已安装编译器、Preact、Node 类型及本轮 SDK/Runtime 后构建通过，未修改该应用业务。

## C01 逐项处理

| 原 ID | 实际处理 | 保留与验证边界 |
| --- | --- | --- |
| D01 | 删除 SnapshotBuilder、重导出和专属测试 | 旧 SnapshotFormatter 等仍有依赖的路径留待 C03 |
| D02 | 删除 Kernel.transformer 注入、兼容 Transformer 类和独占 SPI；更新构造调用 | Worker 纯转换函数保留；HTML 转换集成测试迁到纯函数，保留原断言 |
| D03 | 删除 adapters/session 的实现、类型和私有 barrel | 未增加新会话体系 |
| D04 | 删除 pre-Scope bound-action-executor 及专属测试 | scoped-interaction 仍实际调用 invocation-ledger；来源、授权和结果机制保留 |
| D05 | 删除未使用的 OperationLogBuffer、接口和专属测试 | 当前 logger、日志条目与格式化继续保留 |
| D06 | 删除未使用的旧 ViewTree 类、独占 SPI 类型和导出 | 实际使用的 ViewRegistry、InlineView、owned View 身份仍保留，等待 C04 迁移 |
| D07 | 删除 persistenceManager 单例、导出和 throw-only 测试 | usePersistentState 与实例 persistence 端口保留 |
| D08 | 删除两个无实际能力的 registry Hook、Context 抛错字段及独占类型 | 真实 View/Ref 挂载和清理断言保留；Context 检查改为确认退出字段不存在 |
| D09 | 删除 useResourceRef 及内部数据 useRef alias | 根 Preact useRef、useDataRef、useArrayRef 保留 |
| D10 | 删除 useSignalStore、SignalStore 和 SDK 生产 signals 依赖；同步两种 lock | signals 仅作为 Runtime 归档 SDK fixture 的显式 devDependency；旧测试退出后继续删除，见 E01 待办 |
| D11 | 删除 SDK 通用命名校验再导出、实现和专属测试 | View、参数、来源和 Runtime 必需身份校验保留 |
| D12 | 删除旧 Workspace composer、类型、导出和专属测试 | Semantic Source 的实际多 App 聚合保留 |

D10 复核发现：除 7 处显式链接外，还有 3 组归档 SDK 测试借用当前 SDK 的整个 node_modules。它们已改为测试专用依赖装配，当前 SDK 的验证环境移除了 signals 链接。新增 helper 位于 `runtime/tests/fixtures/`，未进入生产 dist 或 tar；没有删除旧二进制或弱化生命周期断言。

新包消费脚本原先在 Workspace 调用已经迁往 FileDetail 的 write_file。现已按当前 API 获取 FileDetail 的 Observation 和绑定，且通过 Semantic Observation 发现页面，保留实际磁盘写入、LSP hover 和资源释放断言。

全量运行还暴露出一处旧测试屏障：`undefined?.bindingVersion !== oldVersion` 会把工具暂时卸载误认为重新注册完成。屏障已增强为先确认新目标存在，再检查实例/绑定版本；没有延长 timeout 或放宽结果断言。

## 验证与产物

- C00：Driver、Runtime、SDK 及四个应用的当前源码构建有记录。
- C00 SDK 全量：429 项通过。
- C00 Runtime 完整依赖就绪后：2,945 项通过、10 项失败、3 项 skip、7 项 todo。失败用例名称完整保存在 progress.json 和原日志。
- C01：源码构建、全量测试、归档依赖回归、新 tar 消费及 API 检查见 `evidence/c01-*.json`；最终结果以 progress.json 中登记的最终日志为准，失败的中间运行也保留。
- C01 SDK 全量：416 项通过。Runtime 全量：2,914 项通过、与 C00 完全相同的 10 项失败、3 项 skip、7 项 todo；没有新增失败。退出测试为 Runtime 4 个文件共 31 项、SDK 2 个文件共 13 项，逐项分类见进度记录。
- 归档 SDK 依赖与关闭回归 32 项通过；新 tar 的 5 项既有包消费检查全部通过，包括真实默认 Worker、临时磁盘写入、实际 LSP hover 及关闭资源报告。
- 新包消费运行实际 tar 解包后的 Runtime/SDK/IDE，`skipLibCheck:false`；纯 Core 文档以 ES2022-only、`types:[]` 编译并执行。第三方依赖仍为已有安装的链接，因此不宣称已经完成 C09/C10 的干净 npm 安装。
- SDK 新 tar 的 35 个值导出、61 个类型导出与当前文档逐项相等；退出类型通过严格编译反例验证，退休模块的 JS/d.ts/map 路径在四个新 tar 中不存在。
- 本轮 tar 的 SHA-256、npm integrity、成员清单及实际消费者位置保存在 [c01-artifacts.json](evidence/c01-artifacts.json)。它们是 C01 产物，不是 C02–C10 的最终发行物。
- 原仓库 Runtime/SDK dist 也已从当前源码重新构建，避免工作树继续使用本批已删除文件的旧输出。

Runtime 基线的十项失败涉及单模式可见性预期、旧 TTL 预期、根 View 静态文本、归档/off 组合及 IDE 读计数，尚需后续批次逐项判断和解决。本轮不增加 skip/only、扩大 exclude、提高容量或延长超时来隐藏它们。

## 续接与恢复

当前生产入口仍是现有 Semantic Host + View-local SDK；其兼容分支在 G1 后按 C02→C10 顺序退出。下一批必须先迁移成功提交、健康变化和 auto/never/manual 通知，再删除 Fragment，不能颠倒。

| 后续批次 | 本次重新核对的实际迁移接点 |
| --- | --- |
| C02 | WorkerHost 的 SNAPSHOT_PREPARED 接纳与 SNAPSHOT_FRAGMENT 通知仍分离；receiver 的 Core/Scope 所有权及 V2 Producer 必须保留 |
| C03 | createRuntime 仍装配 SnapshotRegistry、Dispatcher、系统操作；Kernel 旧 execute、Fragment 缓存和桌面锁等待 C02 解除依赖 |
| C04 | SDK View 仍注册 InlineView，同时挂载 owned identity；AppKernel 的实际 ViewRegistry 和 onClose/Ref/Tool 顺序需要一起迁移 |
| C05 | useViewTypeTool 仍有 type-wide、ordinary-v1 与 Ref V1 分支；view-tool-invocation-v1 的共享捕获被 V2/lifecycle 使用 |
| C06 | WorkspaceCreateView 仍使用专用创建 Hook；IDE 的真实文件创建、合作锁、工作区校验和 LSP 资源继续归应用 |
| C07 | Factory、持久化 ACK 和关闭报告仍有兼容分支；正式命名与删除 fallback 必须覆盖实际 Worker、I/O 和失败清理 |
| C08 | Semantic Source 仍保留 split-method compatibility 缓存；当前 getContext/release 路径及动态能力过滤继续保留 |
| C09 | 清除后续退出产物、当前导航与 Skill；本批临时归档 SDK helper 和 Runtime signals devDependency 随旧测试退出 |
| C10 | 解决记录中的全部基线失败，再做 I01–I20、默认宿主、业务应用、干净 npm 安装与资源/预算验证；本批的链接依赖消费不代替该门槛 |

`progress.json` 保留全部原 ID、原目标和 I01–I20；不存在因为本批未实施就被移除的任务。后续任务的依赖与迁移要求仍以根目录原始 Markdown 为完整依据。

恢复本轮源码应从 `baseline/active-source.tar.gz` 向临时目录提取目标文件，再与当前文件逐项合并。`changes.patch` 是相对于该脏工作树基线的本轮增量，包含原未跟踪文件的删除；它不是相对于 HEAD 的整仓 diff。应用或反向应用前，应核对 progress.json 所列 before/after 哈希。不要用恢复归档覆盖之后的并发改动。

原暂存区未改动，原有无关源码变化未被本轮回滚；恢复代码不会撤销已经发生的外部业务副作用。
