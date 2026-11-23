# SDK / Runtime 设计讨论 SSOT v2

本目录是 AOTUI SDK 与 Runtime 设计演进、架构权衡与最终决策的**唯一事实来源（SSOT）**。

> **维护规则**
> - 严格区分**现行实现事实**、**已确认共识**、**待讨论候选方案**、**暂缓项**与**已修正/撤回意见**，不把候选设计写成现行能力。
> - 每项议题分别记录三个独立成熟度维度：**问题证实度**、**理想态明确度**、**实现方案状态**，不合并为单一等级或主观信心百分比。
> - 只有经逐点讨论确认并落地的结论，才同步回写至 [AGENTS.md](../../AGENTS.md) 或对应模块 README。

---

<a id="baseline"></a>
## 设计讨论基线

### 1. 核心概念基线
- **页面（View）**：一个 View 实例对应 GUI 网站或桌面应用中的一个页面，可展示多个业务对象，也可在自身生命周期内切换内容或当前对象，不强制一个 View 永久绑定单一业务对象。View 使用 XML + Markdown 呈现，包装为模型 Messages 中的 User Message。
- **事实与记忆**：Projection 是应用当前状态的投影。由 AOTUI 产出的 Messages 既表达外部事实，也是 Agent 对这些事实的工作记忆；Agent 只能通过应用提供的有限操作改变这部分记忆。App 更新真实业务状态，框架再投影已提交的 View、Ref 和动作能力，不提供对任意对话或其他来源记忆的通用 CRUD。
- **长期演进总策略（已确认）**：不以“整体推倒重写 SDK 和 Runtime”为前提，而是**把现有已验证的交互语义提炼为第三方可独立实现、可独立验证的公开合同**，并以此为尺子收敛内部边界、消除泄漏与重复裁决。

### 2. 三项长期 Infra 评估标准（已确认）
1. **跨语言、跨版本独立演进**：先明确第三方可以稳定依赖哪些行为与不变量，再确定传输协议与版本演进规则，避免宿主常规升级迫使第三方重编 App。
2. **内核只保留必要机制（借鉴 Linux 对用户态 ABI 的稳定承诺）**：检验尺子——“换成 Python App、CLI 或另一家模型之后，这条规则是否依然必须成立？”必须成立的进内核合同，否则归宿主或外围适配器。
3. **Agent 开发者的低心智负担**：检验尺子——让 Agent 只读公开 SDK 文档，独立开发一个含两个文件页的真实 App，观察其能否一次写对以及出错后能否自修复，而非仅凭代码行数或是否使用 JSX 下结论。

### 3. 三维度成熟度口径（已确认）
| 维度 | 取值口径 |
| :--- | :--- |
| **问题证实度** | `已复现` · `代码已证实` · `待实测` · `长期演进风险` |
| **理想态明确度** | `已明确` · `部分明确（待定边界）` · `待实验确定` |
| **实现方案状态** | `未开始` · `候选对比中` · `已选定待验证` · `已验证` · `暂缓` |

---

## 逐点评审顺序

- **第一阶段（基础合同与核心机制，已全部完成首轮决策）**：
  1. [`SYS-01`](02-system-design.md#sys-01) 语言无关的公开合同与跨语言边界（**已确认方向与验收标准**）
  2. [`MEC-04`](04-mechanism-design.md#mec-04) 多 App 观察半采纳与请求级原子切换（**已选定方案 B 待实现验证**）
  3. [`CON-02`](01-conceptual-design.md#con-02) 页面能力契约与调用方式（Native 与 `run_code`）解耦（**已选定待验证**）
  4. [`MEC-03`](04-mechanism-design.md#mec-03) Ref 与普通字面值的无歧义表达（**已选定待验证**）
- **第二阶段（剩余 15 项活跃议题，已确认推进顺序）**：
  - **A 组 · 页面怎么呈现，Agent 能做什么（已全部收口）**：`CON-01`（**已选定待验证**）→ `CON-03`（**已确认待迁移落实**）→ `MOD-04`（**已选定待验证**）→ `CON-04`（**已选定待验证**）
  - **B 组 · SDK 与 Runtime 各自负责什么（已全部收口）**：`MEC-06`（**已选定待验证**）→ `MOD-01`（**已选定待验证**）→ `SYS-03`（**已选定待验证**）→ `MEC-07`（**已选定待验证**）→ `MOD-03`（**已选定待验证**）→ `SYS-02`（**已选定待验证**）→ `MEC-05`（**已选定待验证**）
  - **C 组 · 清单、事件与实测（已全部收口）**：`MOD-05`（**已选定待验证**）→ `CON-05`（**已选定待验证**）→ `MEC-02`（**已选定待验证**）→ `MOD-02`（**已选定待验证**）
    - *改代码前的两份基线采样（均已完成留存）*：(1) 连续输出 1,000 行日志时现行 Runtime 实际推帧 54–56 帧（~2.86–2.97 MiB）vs 1A 对照 2 帧（~105 KiB）（见 `MEC-02`）；(2) 干净 Agent 仅读公开文档用纯 TS 与 Preact 同题开发双文件 App 均 0 轮修复一次跑通，并实测定位到容量拒绝收据与文档缺口（见 `MOD-02`）。
- **暂缓 / 低优项**：`SYS-04`（暂缓）、`MEC-01`（暂缓）、`CON-06`（低优 TODO）。

---

## 议题全景索引（22 项）

### 一、概念设计（[01-conceptual-design.md](01-conceptual-design.md)）
| ID | 议题 | 问题证实度 | 理想态明确度 | 实现方案状态 |
| :--- | :--- | :--- | :--- | :--- |
| [CON-01](01-conceptual-design.md#con-01) | DOM 渲染与窗口折叠的职责边界 | 代码已证实 | 已明确 | **已选定待验证** |
| [CON-02](01-conceptual-design.md#con-02) | 页面能力契约与调用方式解耦 | 代码已证实 | 已明确 | **已选定待验证** |
| [CON-03](01-conceptual-design.md#con-03) | `Static / Dynamic` 分区、框架分配 `view_id` 与 `view_type` 命名校验 | **已复现**（命名校验差距） | 已明确 | **已确认待迁移落实** |
| [CON-04](01-conceptual-design.md#con-04) | Ref 路径授权、系统级 Ref 查看与大对象只读句柄 | 代码已证实 | 已明确 | **已选定待验证** |
| [CON-05](01-conceptual-design.md#con-05) | 异步事件、唤醒判定与变更传播边界 | 代码已证实 | 已明确 | **已选定待验证** |
| [CON-06](01-conceptual-design.md#con-06) | PTC（`run_code`）模式下查询 App 的 ViewType 与页面实例清单 | 代码已证实 | 部分明确（待定边界） | 未开始（低优 TODO） |

### 二、系统设计（[02-system-design.md](02-system-design.md)）
| ID | 议题 | 问题证实度 | 理想态明确度 | 实现方案状态 |
| :--- | :--- | :--- | :--- | :--- |
| [SYS-01](02-system-design.md#sys-01) | 语言无关的公开合同与跨语言边界 | 代码已证实 | 已明确 | **已确认方向与验收标准** |
| [SYS-02](02-system-design.md#sys-02) | 信任模型与防御检查的收益审计 | 已复现 | 已明确 | **已选定待验证** |
| [SYS-03](02-system-design.md#sys-03) | 可选持久化与内核类型及关闭流程解耦 | 已复现 | 已明确 | **已选定待验证** |
| [SYS-04](02-system-design.md#sys-04) | 单 Agent 串行与多 Agent 共享演进边界 | 长期演进风险 | 部分明确（待定边界） | **暂缓** |

### 三、模块设计（[03-module-design.md](03-module-design.md)）
| ID | 议题 | 问题证实度 | 理想态明确度 | 实现方案状态 |
| :--- | :--- | :--- | :--- | :--- |
| [MOD-01](03-module-design.md#mod-01) | Core 依赖过宽与作者/宿主侧代码切分 | 已复现 | 已明确 | **已选定待验证** |
| [MOD-02](03-module-design.md#mod-02) | 纯 TS 与 Preact 两条作者路径独立及实证对比 | **已复现**（双路径实证 + 容量超限复现） | 已明确 | **已选定待验证** |
| [MOD-03](03-module-design.md#mod-03) | Runtime 职责收口与消除跨层重复裁决 | 已复现 | 已明确 | **已选定待验证** |
| [MOD-04](03-module-design.md#mod-04) | Host API 实例句柄直返与 `observe`/`adopt` 分离 | 代码已证实 | 已明确 | **已选定待验证** |
| [MOD-05](03-module-design.md#mod-05) | `aoapp.json` 静态生成与权限声明边界 | 已复现 | 已明确 | **已选定待验证** |

### 四、机制设计（[04-mechanism-design.md](04-mechanism-design.md)）
| ID | 议题 | 问题证实度 | 理想态明确度 | 实现方案状态 |
| :--- | :--- | :--- | :--- | :--- |
| [MEC-01](04-mechanism-design.md#mec-01) | Preact 私有钩子依赖与开页超容恢复机制 | 已复现 | 部分明确（待定边界） | **暂缓** |
| [MEC-02](04-mechanism-design.md#mec-02) | 高频流式变更下的整帧成本与版本号封装 | **已复现**（1,000 行连续日志对照实测） | 已明确 | **已选定待验证** |
| [MEC-03](04-mechanism-design.md#mec-03) | Ref 与普通字面值的无歧义表达 | 代码已证实 | 已明确 | **已选定待验证** |
| [MEC-04](04-mechanism-design.md#mec-04) | 多 App 观察半采纳与请求级原子切换 | **已复现** | 已明确 | **已选定待验证** |
| [MEC-05](04-mechanism-design.md#mec-05) | 配额记账简化与活跃责任持有分离 | 代码已证实 | 已明确 | **已选定待验证** |
| [MEC-06](04-mechanism-design.md#mec-06) | Schema 合同独立于 TypeBox 与多库映射边界 | 代码已证实 | 已明确 | **已选定待验证** |
| [MEC-07](04-mechanism-design.md#mec-07) | 生命周期内部动词精简与关闭阶段事实保留 | 代码已证实 | 已明确 | **已选定待验证** |

---

## 简短决策记录

| 日期 | 编号 | 决定摘要 | 状态 |
| :--- | :--- | :--- | :--- |
| 2026-11-23 | BASELINE | 确立三项长期评估标准、三维度成熟度口径、不整体推倒重写而是先提炼可独立验证合同的策略，以及首轮讨论顺序 `SYS-01 → MEC-04 → CON-02 → MEC-03`。 | 已确认 |
| 2026-11-23 | SYS-01 | 确立 App 为套 CLI/MCP/HTTP 的前端交互壳定位；优先打通跨语言 Agent 消费已有 App（边界 A），暂不做多语言 App SDK 且不为现有 Demo 背历史兼容包袱；锁定 App/Runtime 五项职责与“Runtime 记住选了谁、App 检查还能不能做”的 Ref 分工；以 Python Agent 使用 TS 双文件页 App 作为核心验收考试，通信格式与版本号细节按实际需要后定。 | 已确认 |
| 2026-11-23 | MEC-04 | 选定方案 B（单一有效完整来源名单）：Runtime 一次采用一轮请求的完整名单及跨 App Ref 绑定，成功一起切换、失败不改旧名单；省略的旧 App 立即撤销；复用同一观察不等于复用上一轮调用入口；Desktop 统一走请求级入口；页面关闭与撤权即时有效，已分发调用按原来源结算，5 项对抗测试为必过验收。 | 已确认 |
| 2026-11-23 | CON-02 | 聚焦 Native 与 `run_code`（暂缓 CLI）：动作业务契约单点声明由外围各自投影；`view_id` 继续由框架保留用于选页（单实例省略），两种入口遵守同一开页与轮次规则；Ref 授权选定简化 3A，仅区分“某页面要用”与“本轮脚本要读”两种消费者，由 Host 用一份名单决定、Runtime 交付时强校验；新增低优 TODO `CON-06`（PTC 查询 ViewType 与实例）。 | 已确认 |
| 2026-11-23 | MEC-03 | `run_code` 用 `ref(地址)` 且在跨进程 JSON 发送前显式识别编码；Native 选方案 B（`{"$aotui_ref": ...}`）+ `{"$aotui_literal_json": ...}` 原样 JSON 逃生通道 + B-按需工具说明（规避 Claude 16 联合参数限制）；`refParam` 与普通参数统一显式引用写法；仅识别顶层参数与直接数组元素；三家严格模式兼容性记为待真实接口验证。 | 已确认 |
| 2026-11-23 | CON-01 | 选定方案 1：Host 持有折叠状态与 Agent 备注（`note`），Runtime 仅维护每页两项独立资格（可接收调用、可提供 Ref）与折叠生效时的当前轮不可逆即时撤权；主动折叠仅剩 `expand_view` 与独立 `close_view`，预算提示保留所留工具可用（并诚实标示预算受限）而禁用 Ref；模拟 DOM 留作 Preact 内部细节；确认系统级 Ref 结构/值查看需求并归入 `CON-04` 细化。 | 已确认 |
| 2026-11-23 | CON-03 | 正式保留 `region: 'static' | 'dynamic'`（及 `<StaticView>` / `<DynamicView>`），废弃 `instruction / state`；最终决定**取消开发者自定义 `createId`**，多实例 `view_id` 由框架分配（跳过同 App 实例已占用 ID）并查重（现行 SDK 回调与 IDE/终端使用方随实现阶段迁移）；登记现行 `view_type` 命名校验放行 `4_2`/`___` 的差距为待落实修复项（须至少含一个 ASCII 字母）。 | 已确认 |
| 2026-11-23 | MOD-04 | 确认句柄链直返（`createDesktop → Desktop`、`openApp → RunningApp`、`adoptTurn → ActiveTurn`），`adoptTurn` 可直接传候选观察对象；保留准备与采用分离，迟到 `oldTurn.release()` 不得伤及新轮；授权选 2A（`createDesktop({ policyForApp })` + `openApp` 显式覆盖，实例绑定一次不可替换，策略构造失败不静默降级）；明确错误分界与 `finally` 保首错；`readReceipt` 挂在 `RunningApp` 并附可保存定位信息（内存收据无跨重启保证），锁定计数器超时复用验收场景。 | 已确认 |
| 2026-11-23 | CON-04 | 确立三项简化规则：本轮可见 Ref 可看其声明完整结构（暂不做字段名级路径权限表，路径仅用于少取数据）；每个 Ref 发布时必须声明 Schema 并在 SDK 发布期校验值匹配（`private`/`protected` 看结构不泄动态键与长度等运行数据）；仅本轮可见 `public` Ref 可直接打印值，`private`/`protected` 禁读值（同步修正旧“可见 `public` 邮箱却禁 Agent 打印”示例）。查看工具选 1A：`system-inspect_ref(address, mode)`，`run_code` 同规则；大对象确立 H1 原观察固定版本规则，存储方案暂缓。 | 已确认 |
| 2026-11-23 | MEC-06 | 工具参数与 Ref 共用公开 JSON Schema 2020-12 支持子集并配语言无关测试向量；去掉 `refParam` 的假字符串 `type: 'string', minLength: 1`；Ref 必带结构须拒绝无约束空声明 `{}`（SDK 发布期与 Runtime 接收期同把关）；SDK 工具根默认导出 `additionalProperties: false`（尊重嵌套对象自身声明，且 Runtime 对直接标准 JSON Schema 仍按标准允许额外字段）；`default` 维持不自动回填；禁用作者 `pattern` 关键字；现阶段沿用 TypeBox，未来接库以“仅凭导出 JSON 即可等价判定”为准入红线，三家严格模式另行真实接口验收。 | 已确认 |
| 2026-11-23 | MOD-01 | 保留单 npm 包 `@aotui/core`，把**根入口做薄**，按职责切分为 4 个出口：`@aotui/core`（共享规则与校验）、`/producer`、`/host`、`/persistence`；抽离共享开页容量检查，避免 Worker 借道拉入 Host；将 SDK 内 `modelToolSchema()` 体积检查迁至 Native/`run_code` 适配器；按归属收回并取消 `@aotui/core/internal` 总入口；本轮保留 `acorn` 依赖但守死“导入并使用 SDK 零加载”；扩展既有 `verify-package-consumer.mjs` 在“导入 + 声明带工具页面 + 创建最小 App”后按实际加载文件验收；运行时未启用持久化零加载移交 `SYS-03` 验收。 | 已确认 |
| 2026-11-23 | SYS-03 | 第 1 点确认双端按需加载（有清单带出 `persistenceSupport` 供 Worker 核对，无清单由 Worker 发现 `persistence: true` 后向主线程申请，双场景验收零加载与零介入）；第 2 点选 2A（`CloseReport.resources` 通用化、`persistence` 按需出现，严守“App 清理→停新写→等落盘确认→释资源”顺序，从打开后端起即计未结束工作，保住 5 项关闭/重试行为）；第 3 点选修正后 3A（保留 Node 默认 SQLite 惰性按需加载与自定义后端替换，修正“按 Runtime 各建独立后端”为“各 Runtime 释放自身资源、同一物理目录占用由存储适配器统一协调、最后使用者退出后关存储 Worker”）；`StateStorageBackend` 归 `@aotui/core/persistence`。 | 已确认 |
| 2026-11-23 | MEC-07 | 保留关闭四阶段并将第 2 阶段正名为“等待已接单的工作”（宽限期到期记“未知”，仅确认未派发/未进 handler 才记“未执行”；`report.ok` 含 `verification === 'managed'`；Worker 退出即还名额但存储未释时 `resourcesReleased` 仍为 `false`）；删 `APP_SHUTDOWN` 只留 `APP_STOP` + `APP_CLOSE`（保住初始化中途关闭与迟到登记清理）；Host 选 3A 三级统一 `beginClose()`（撤掉同义词壳子，复调用共享、后续重试只补释放且保首错）；移除 `reinitialize` 并选 4B 撤掉 `delete` / `intent: 'delete'` / `APP_DELETE` / `onDelete`（永久删数据归明确业务操作）。 | 已确认 |
| 2026-11-23 | MOD-03 | 确立 `App → Desktop → Runtime` 三级关闭报告（上层汇总子报告且报告自身职责，如日志清理失败使 Desktop 失败而 App 仍成功）；撤掉 `WorkerSandbox` 与 `AppManager` 平行关闭报告但守住“刚接启动请求未返句柄即关桌面”的竞态保护（登记表可留作 Desktop 内部实现）；`AppWorkerHost` 卸下折叠备注与持久化后按“Worker 通信 / 交互桥接 / 单实例生命周期”三块正交拆分并共享同一笔在途调用事实；删 `cleanupAsync()` 二次入口并补锁定验收：仅持 `Runtime` 句柄重试关闭也须补释未释放资源且保留首错、不重写不重清；`beforeClose` 选 3A 移除。 | 已确认 |
| 2026-11-23 | SYS-02 | 第 1 项确认“外部可变数据接手时拷贝一次，在同一副本上分别检查原始参数/Ref 展开/整条消息各自上限”（省掉重复排序序列化但保留准确 UTF-8/转义字节计算与防重指纹；Worker 在收到副本上直接核对并落实只读，主线程核对回包归属，坏回包记未知）；第 2 项确认公开入口一次校验并**深度固定嵌套启动配置**（服务对象按引用传），内部层消费已固定对象、真实 IPC 仍核对协议/实例/必填字段（不靠假 Worker 造 getter）；第 3 项选 3B（主线程解一次 Ref 并验型，Worker 核对实时实例/页面/工具/本地 Ref 范围后再用本地 Schema 直接验一次最终业务值且不整树重拷贝；拆出 `scopeAllows` 以真实 Worker 验收零加载 `acorn`）。 | 已确认 |
| 2026-11-24 | MEC-05 | 确认“谁还在用就继续持有、关闭直查实际持有者释放（删 `retainedBytes === 0` 推断）”；快照大小只在 `SnapshotStore` 算一次、观察与调用各自借还（删另外两层重复拷贝算字节与固定 `1 MiB` 虚拟预扣退款），新生成数据（展开 Ref、观察元数据）在生成时各自查一次上限；收据选 3B（先查编号防重、新调用先占名额满则当场拒、正文过期可清但原观察有效期内留编号防重做，**同步收紧默认 `maxReceipts`** 消除 `1024 × 560 KiB` 过高理论上界，不加 `maxReceiptBytes`）。 | 已确认 |
| 2026-11-24 | MOD-05 | 选定 1A：以 `package.json`（沿用 `version/main/types/description` + `aotui` 小节写 App 专有声明）作为唯一手写源，App 代码与生成器共用；`generate-aoapp` 纯静态读文件、查入口存在并填 SDK 协议标识（不 `import()` 业务代码、走 `@aotui/core` 薄根入口、删工厂检查私有辅助），导出与启动校验归发包真实 Worker 测试；补齐清单与工厂的**双向持久化核对**（严格区分“有清单未声明”与“无清单裸模块”，两种错配均在业务初始化前拒之门外）；不加无法强制执行的 `fs / net / shell` 纸面权限，保留可落实的 `persistenceSupport`。 | 已确认 |
| 2026-11-24 | CON-05 | 选定 2A 最小版：SDK 提供零参数 `requestAttention()` 供 App 在工具早已返回后的后台里程碑提醒 Host（业务事实只写一次进 View），普通工具调用无需手动提醒；移除 `signalPolicy: 'auto' | 'never'`（因 `never` 连预览刷新也一并关闭）；复用 Desktop 通知入口并按真实事实分类（页面更新/投影出错恢复/App 开关/请求关注），带上真实 `appId` 与 `instanceId`；Host 核对实例有效性与启用范围并自行决定唤醒或合并，下一轮仍走正式 `observe → adoptTurn` 看完整最新页面；内部传输是否做 Diff 交由 `MEC-02` 实测决定。 | 已确认 |
| 2026-11-24 | MEC-02 | 选定 1A：打开时发首帧，之后正文按需传整帧（无预览订阅不主动推整帧，可合并轻量更新通知，Agent 监听唤醒建议不算预览；有预览由 Host 控制 100–200ms 刷新并保尾帧；Agent 正式观察直走 `FLUSH_PROJECTION`；守死“无人预览时权限变更如 `public→private` 仍须向来源核对实时资格、有资格则取原观察值”）；对照实测 1,000 行日志+两静态页从 54 帧 ~2.86 MiB 降至 2 帧 ~105 KiB；保留 `sourceEpoch / producerSeq / revision` 三编号并将前两者封入内部协议（纠正现行判重为规范化内容比对 + FNV-1a 64 诊断摘要而非 SHA-256）；健康首帧来自当前 Worker/实例且 Store 接收成功即可作基线。 | 已确认 |
| 2026-11-24 | MOD-02 | 选定 1A（包根入口提供 Preact、`@aotui/sdk/app` 提供纯 TS，两条路径平等支持、按场景选型并遵守同一交互规则，撤回“Preact 必须维护两份状态”误判）；选定 2A（保留单包 `@aotui/sdk`，以打包后独立项目验收纯 TS 零 Preact/DOM）；保留 `refType` 与 `itemType` 语义区分；README 并排展示同一个双文件例子及“页满了”仅捕获已确认容量拒绝的处理；固化“固定脚本回归 + 重大变更干净 Agent 盲测”两级验收。 | 已确认 |
