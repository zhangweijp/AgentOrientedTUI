# 三、模块设计（MOD-01 ~ MOD-05）

返回 [设计索引](00-index.md)。

---

<a id="mod-01"></a>
## MOD-01：Core 依赖过宽与作者/宿主侧代码切分（已选定待验证）

- **问题证实度**：已复现
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码导入图与独立进程复现）
- 独立 Node 进程按包名导入当前工作区构建产物复现：`@aotui/sdk/app` 与 `@aotui/sdk` 均加载了 **27 个 Core JS 模块**（包括快照仓库、观察注册表、投影协调器、持久化会话）并拉入 `acorn`；纯 TS 入口已避开 `preact` 与 `linkedom`（启动耗时收益另行单独测量）。
- `@aotui/sdk` 真正需要的共享运行逻辑极少，但存在三处跨角色耦合：
  1. [core/src/index.ts](../../core/src/index.ts) 为单一平铺大桶入口，[core/src/internal.ts](../../core/src/internal.ts#L2) 首行即导出整个根入口并暴露 20 个混杂各角色的内部导出；
  2. Worker 开页容量检查目前从 Host 侧观察注册表导入（[AppKernel.ts](../../runtime/src/worker-runtime/app-kernel/AppKernel.ts#L99)），若不抽离共享检查，仅改子路径仍会让 Worker 顺着旧依赖加载整套 Host；
  3. SDK 声明工具时仍在 [view-type-tool.ts](../../sdk/src/tools/view-type-tool.ts#L189) 调用 `modelToolSchema()` 检查发给模型的工具说明大小；同时 Worker 侧目前仍参与带 Ref 参数重建（[tool-invocation.ts](../../runtime/src/adapters/tool-invocation.ts#L25)），地址解析（含 `["display.name"]`、引号转义与数组下标，见 [ref-parameters.ts](../../core/src/tool/ref-parameters.ts#L21)）尚未完全收归 Host。

### 2. 已修正/撤回意见
- 撤回“保留重根入口 `@aotui/core` 并新增第 5 个 `@aotui/core/author` 子路径”的初稿方案：直接把根入口 `@aotui/core` 做薄为共享合同，避免作者和工具链必须记住“禁止从根入口导入”的项目纪律。

### 3. 已确认决策
1. **保持单 npm 包 `@aotui/core`，严格切分为 4 个出口（根入口做薄）**：

| 入口 | 职责 |
| :--- | :--- |
| `@aotui/core` | SDK 与 Runtime 共同理解的共享规则：页面、Ref、业务参数结构、常量、错误、纯 JSON Schema 子集校验器（`MEC-06`）、Ref 捕获辅助与共享容量检查。**零 Host 引擎、零 Producer 引擎、零持久化实现、零 `acorn`。** |
| `@aotui/core/producer` | App/Worker 侧帧组装与提交（如 `SemanticProjectionCoordinator`、`commitAppFrame`）及视图归属工具注册。 |
| `@aotui/core/host` | Host 侧快照存储、轮次名单/观察/调用引擎（`MEC-04`）、Ref 地址解析与解引用。 |
| `@aotui/core/persistence` | 启用框架持久化时的状态会话、读取、保存与清理逻辑（衔接 `SYS-03`）。 |

   - 自定义宿主需同时组装 `producer` 与 `host` 时显式导入对应子路径（[public-core.ts](../../core/examples/public-core.ts) 随迁移调整导入行）。
2. **共享检查与职责归位**：
   - 抽离 Worker 与 Host 共用的开页容量检查，保住“新页放不下就拒绝打开”且不让 Worker 依赖整套 Host；
   - 按 `MEC-06` 将 SDK 中 `modelToolSchema()` 的模型工具体积检查移交 Native 与 `run_code` 适配器承接，确保超限报错不丢失；
   - 将 `@aotui/core/internal` 中的函数按职责归位（`producer` / `host` / `persistence` / `runtime` 内部），并取消总汇式 `internal` 导出入口；
   - 本轮保留 `acorn` 作为 `@aotui/core` 依赖（同包安装属于本轮取舍），验收红线为**导入并使用 SDK 时零加载 `acorn`**；是否替换解析器留待后续以同一组地址用例与实测收益再定。
3. **防回退自动化验收（扩展既有包消费测试）**：
   - 直接扩展 [verify-package-consumer.mjs](../../sdk/tests/package-consumer/verify-package-consumer.mjs#L82)，在独立 Node 进程中按**实际加载的文件路径**检验（不只测 `import`，必须执行到**声明带工具页面并创建最小 App**，防止错误依赖延迟到 `defineViewType()`）：
     - `@aotui/sdk/app`：必须避开 Host 引擎、Producer 引擎、持久化实现、`acorn`、`preact`、`linkedom`；
     - `@aotui/sdk`：必须避开 Host 引擎、Producer 引擎、持久化实现、`acorn`（允许加载 Preact 与 DOM 适配器）。
   - 验证“未启用持久化的 App 实际运行时在主线程与 Worker 中均零加载存储实现”移交至 [SYS-03](02-system-design.md#sys-03) 验收。

### 4. 决策记录
- **2026-11-23（已确认）**：确定 `@aotui/core` 单包 4 出口且根入口做薄、抽离共享开页容量检查、迁移 `modelToolSchema()` 大小检查至适配器、按职责收回并取消 `internal` 总入口、`acorn` 本轮保留但 SDK 零加载、以及扩展 `verify-package-consumer.mjs` 执行声明与最小 App 创建后按实际加载文件验收。

---

<a id="mod-02"></a>
## MOD-02：纯 TS 与 Preact 两条作者路径独立及实证对比（已选定待验证）

- **问题证实度**：**已复现**（双路径同题 Agent 实证 + 容量超限收据复现 + 零 DOM 导入验证）
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实与受控实证基线（改代码前）
- **同题双路径实证**：两个干净独立子 Agent 仅读公开 [sdk/README.md](../../sdk/README.md) 与发布态 `.d.ts`，分别用纯 TS（`@aotui/sdk/app`，160 行）与 Preact（`@aotui/sdk`，197 行）实现同一个双文件页编辑 App，均在真实 TS 7 `strict + exactOptionalPropertyTypes` 编译与真实 Runtime 6 项验收上 **1 次通过、0 轮修复**；在加载纯 TS 样例时拦截 `preact` 与 `linkedom` 导入，应用声明仍正常载入。
- **开页超容收据实测**：将容量收紧至仅容首页与 `a.txt` 再打开 `b.txt`，两份原样例均保住了 `a.txt`（仍可编辑，关掉后均可开 `b.txt`），但未显式处理容量拒绝时均向 Agent 返回了 `ACTION_OUTCOME_UNKNOWN`；仅捕获已确认的容量拒绝后，两边均可明确提示“页面已满，先关一个文件再试”，同时把真正结果未知的异常留给 Runtime 如实报告。
- **包依赖现状**：[sdk/package.json](../../sdk/package.json#L40) 已将 `preact` 设为可选 `peerDependencies`，`linkedom` 仍列在 `dependencies` 中（运行期纯 TS 零加载）。

### 2. 已修正/撤回意见
- 撤回初稿“Preact 必须维护 `useState + useRef` 两份状态”的过宽判断：实测去掉 Preact 样例中的 `useRef` 镜像改用函数式状态更新后，同样 **6/6 通过**。
- 撤回初稿“合并/简化 `refType` 与 `itemType`”的建议：两者表达不同语义，保留各自命名。

### 3. 已确认决策
1. **选定 1A：双路径正式并行支持，按 App 需要选型**：
   - **准则定位**：包根入口（`@aotui/sdk`）继续提供 Preact，`@aotui/sdk/app` 提供纯 TS，作者按页面需要选择，两者遵守同一套交互规则。
   - **选型建议**：给现有工具套一层界面（列出文件、打开、修改等）优先用纯 TS；多个页面需要复用同一套列表、表格或表单组件时选 Preact。
2. **选定 2A：保留单包 `@aotui/sdk`，把纯 TS 入口的独立性测实**：
   - 对纯 TS 作者的直接保证是：用 `@aotui/sdk/app` 编写、编译和运行 App，全程用不着 Preact 或 DOM。
   - 正式验收从打包后的 SDK 安装进独立项目编译并运行小 App（衔接 [verify-package-consumer.mjs](../../sdk/tests/package-consumer/verify-package-consumer.mjs#L82)）；未来若真有部署环境要求“连 DOM 依赖都不能安装”，再拆包以获得明确收益。
3. **补齐 README 双写法并排示例与两级验收体系**：
   - **保留 `refType` 与 `itemType`**：`schema` 说明整份数据结构，`refType` 标识整项 Ref 业务类型，`itemType` 标识数组单个元素业务类型（如 `string[]` 的文件名与邮箱区别，在 [refs.ts](../../sdk/src/app-factory/refs.ts#L30) 与 README 用该例讲清）。
   - **README 并排展示同一个双文件例子**：纯 TS 展示提交含新页的完整页面列表；Preact 展示从 `useAppRuntimeContext()` 取开页方法、把 Ref hook 放进所属 View 子组件、以及为多实例列表传稳定 `key`；两边共同展示独立关页、返回失败收据，以及**只捕获已确认容量拒绝以给出“页面已满，先关一个文件再试”**（不吞掉真正结果未知的异常）。
   - **两级验收制度**：日常回归用固定脚本检查两条路径（含“页满了”场景）；当作者接口或入门说明发生明显变化时，再让干净 Agent 只读公开材料从零做题——前者回答“SDK 还对不对”，后者回答“作者能不能自己写对”。

### 4. 决策记录
- **2026-11-24（已确认）**：选定 1A（双路径正式并行、按场景选型）、选定 2A（保留单包、打包后独立项目验收纯 TS 零 Preact/DOM）；保留 `refType / itemType` 语义区分，README 并排补齐双文件例子与“页满了”容量处理示例，固化“固定脚本回归 + 重大变更干净 Agent 盲测”两级验收；撤回“Preact 必须维护两份状态”误判。
---

<a id="mod-03"></a>
## MOD-03：Runtime 职责收口与消除跨层重复裁决（已选定待验证）

- **问题证实度**：已复现
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码审计与实测复现）
- 现行引擎存在 `Kernel → Desktop → AppManager → WorkerSandbox → AppWorkerHost` 五层叠加，单个 App 关闭结果被 `HostResourceReport → SandboxCloseReport → sandboxCloseReport() → AppManagerCloseReport` 逐层翻译重判，且 `WorkerSandbox / SandboxCloseReport / AppManagerCloseHandle` 无外部消费者。
- 实测发现现行 [kernel/index.ts](../../runtime/src/kernel/index.ts#L197) 存在一处资源释放重试缺口：当 `notes` 写入 1 次、Worker 名额归零但内存存储首次释放失败后，再次调用 `runtime.beginShutdown()` 仅返回旧句柄（释放次数仍为 1），只有通过原 `Desktop` 才触发第 2 次释放并使占用归零。
- `Desktop.beginClose({ beforeClose })` 仅在端到端测试（[batch-seven-desktop-owner.e2e.ts](../../host/test/batch-seven-desktop-owner.e2e.ts#L348)）中使用，生产 Host（[session-manager-v3.ts](../../host/src/core/session-manager-v3.ts#L654)）已自行编排会话收尾。

### 2. 已修正/撤回意见
- 补正初稿“上层只汇总”表述：准确边界是**上层汇总子报告，同时报告自身负责的事项**（例如 `notes` 保存成功但 Desktop 清理日志失败 → App 关闭成功，Desktop 关闭失败）。
- 补正初稿对 `beforeClose` 时点的说明：将代码放到 `beginClose()` 前后并不能复现“App 收尾后、订阅和日志清除前”的时点；移除它的充分理由是生产 Host 已自行编排且失败不阻断 Desktop 关闭，测试改为注入真实延迟/失败的日志清理或资源释放即可。

### 3. 已确认决策
1. **确立 `App → Desktop → Runtime` 三级关闭报告，撤掉中介重复报告**：
   - **App 实例（`scope: 'app'`）**：回答业务写入收据、清理函数完成、Worker 退出与自身托管资源释放，产出唯一权威 `AppCloseReport`；
   - **Desktop（`scope: 'desktop'`）**：回答本桌所有 App（含刚刚接下、仍在启动中的请求）均已纳入关闭，以及本桌订阅和日志清理结果；直接沿用各 App 结论并附加自身结果；
   - **Runtime（`scope: 'runtime'`）**：回答已停建新桌面、刚接受创建的桌面均已关好、全局 Worker 名额全部归还。
   - **撤掉 `WorkerSandbox` 与 `AppManager` 平行关闭报告**，但守住“Host 刚点开 `notes`、未拿到 `RunningApp` 就关桌面”的竞态保护（Desktop 从接下启动请求起即登记，迟到启动成功不得复活旧实例，重开旧回包不得命中新实例）；`AppManager` 的登记表可保留为 Desktop 内部实现。
2. **`AppWorkerHost` 卸下外移职责后按三块正交拆分**：
   - 卸下窗口折叠备注（`CON-01` 归 Host，折叠后旧调用拒绝仍归 Runtime）与持久化宿主胶水（`SYS-03` 可选资源扩展）；
   - 剩余核心按三块拆分并共享同一笔在途调用事实（以“`edit_file` 已发出但等回信超时”为试金石：报“结果未知”、跟踪迟到收据到原调用、不自动重写、关闭等待同一笔工作，不再三处各养一份状态）：
     1. **Worker 通信**：消息路由、请求关联、线程真实退出确认与归还 Worker 名额；
     2. **交互桥接**：轮次/页面/授权/收据规则（沿用 Core）与调用派发；
     3. **单实例生命周期**：停新活、等已接单工作、协调 App 与存储收尾、产出实例关闭报告。
3. **删除 `cleanupAsync()` 二次入口，移除 `beforeClose`（选定 3A），补锁 Runtime 级释放重试验收**：
   - 删除 `AppManager.cleanupAsync()` 二次入口，由 Desktop 自行清理已无运行实例且已完全释放的登记项；**仍有未释放资源的实例必须保留到能找到原负责人重试**；
   - **新增必过验收条件**：**Host 即使只拿着 `Runtime` 句柄，也能重试那一项未释放的资源；重试保留第一次错误，既不重写数据，也不重跑 App 清理**；
   - 移除 `beforeClose` 钩子及其专属计时器与七态报告枚举，对应端到端测试迁移为真实延迟/失败的日志清理或资源释放。

### 4. 决策记录
- **2026-11-23（已确认）**：确立三级关闭报告与每层自身职责边界、撤掉中介关闭报告并守住启动中途关桌面竞态、确认 `AppWorkerHost` 三块正交拆分共享在途调用事实、删除 `cleanupAsync()` 与 `beforeClose`（3A），并写入仅持 `Runtime` 句柄可重试释放的硬性验收条件（本轮针对现行实现选跑 20 项测试全通，代码迁移归实现阶段）。
---

<a id="mod-04"></a>
## MOD-04：Host API 实例句柄直返与 `observe` / `adopt` 分离（已选定待验证）

- **问题证实度**：代码已证实
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码证实）
对照 [runtime/README.md](../../runtime/README.md#L13-L65) 与 [kernel.interface.ts](../../runtime/src/spi/runtime/kernel.interface.ts)，宿主跑通最小调用路径存在多重手工 ID 拼接：`createDesktop()` 只返 `desktopId`、`openApp()` 只返 `appId`、须反查 `getInstalledApps()` 取 `appInstanceId` 再调 `getAppInteraction()`，随后再手工循环 `adoptObservation()` + `bindRequestSources()`。

### 2. 已确认决策
1. **实例与轮次句柄直返（`Desktop → RunningApp → ActiveTurn`）**：
   - `createDesktop()` 直接返回 `Desktop`；`openApp()` 直接返回打开成功即绑定 `(appId, instanceId)` 的 `RunningApp`（关掉重开后，旧句柄的 `observe` / `close` / `readReceipt` 均不能作用于新实例）；`adoptTurn()` 直接返回本轮唯一的 `ActiveTurn`。
   - **候选对象直传**：`app.observe()` 返回候选观察对象后，`adoptTurn` 可直接传入该候选对象（附带 Host 本轮选中的工具接收页与 Ref 来源页），由 Runtime 核对所属 Desktop 与 App 实例，免去手工配对 `{ app, observationId }`。
   - **准备与采用严格分离，且迟到释放不伤新轮**：预算不通过则释放候选、旧轮仍有效；采用成功原子移交候选持有责任；复用同一观察时旧 `turn` 不可再发起调用，**迟到的 `oldTurn.release()` 绝不能撤掉新轮**（该规则同样适用于同轮折叠撤权）。
   - 保留 `getDesktop`、`listApps` 用于目录发现；恢复旧操作必须核对保存的 `instanceId`。未来 Python Host 可凭 Runtime 签发的句柄标识表达同等关系。
2. **授权策略选定 2A（桌面默认工厂 + 实例显式覆盖）**：
   - 支持 `createDesktop({ policyForApp })` 桌面级策略工厂（自动打开或重新初始化 App 时同样生效），仅在某次打开需特殊规则时由 `openApp(..., { policy })` 显式覆盖。
   - **两条硬边界**：策略由可信 Host 提供，在新实例可被观察或调用前绑定一次，**查找现有实例绝不替换其策略**；显式配置的策略构造失败必须报错，**不能悄悄降级为默认权限**。跨语言（Python）接入时约定“谁决定权限、何时生效”，JS 回调仅是本地写法。
3. **错误与报告分界**：
   - 创建、注册、打开失败 → 抛带稳定 `code` 的错误；
   - 观察、采用、调用、查收据 → 返回结构化结果，明确区分“已拒绝、业务未执行”与“已发出、结果未知”；
   - 关闭保留 `CloseReport`（区分请求关闭、关闭流程结束、底层资源实际释放三件事），且 `finally` 清理时保留最先发生的错误，避免关闭异常盖掉原失败。
4. **`readReceipt` 挂在 `RunningApp`（并支持 Desktop 同校验查询）**：
   - 旧轮结束后，只要原实例仍在、记录未过期且 Host 有读取权限，仍可通过原 `(observationId, invocationId)` 查收据；查收据不恢复旧轮执行资格。
   - 调用结果直接附带可保存的收据定位信息（Desktop / App / 原实例 / 观察与调用编号）；实例销毁或记录过期如实返回不可用；当前内存收据不承诺跨 Runtime 重启保存。

### 3. 核心验收场景
- **第一轮发出“加一”后超时 → 第二轮复用同一份计数器观察**：此时旧轮不能再加一，原实例仍可按权限查询第一次的收据；随后**关掉计数器再重开**：旧句柄既改不到新计数器，也查不到新实例的收据（同时检验实例身份、轮次资格与收据归属）。

### 4. 决策记录
- **2026-11-23（已确认）**：确认句柄直返（`adoptTurn` 直传候选观察对象）、迟到 `oldTurn.release()` 不伤新轮、授权 2A 与不可替换/不可静默降级、错误分界与 `finally` 保首错、`readReceipt` 挂原 `RunningApp` 及上述验收场景。

---

<a id="mod-05"></a>
## MOD-05：`aoapp.json` 静态生成与权限声明边界（已选定待验证）

- **问题证实度**：已复现
- **理想态明确度**：已明确
- **实现方案状态**：**已选定待验证**

### 1. 现状事实（代码核实与实验复现）
- **生成期执行业务入口复现**：构造临时 App 在入口顶层写标记并抛错，现有 Runtime 发现（`readAppManifest`）成功且未留下标记；但现有 [generate-aoapp.mjs](../../sdk/bin/generate-aoapp.mjs#L21) 触发了标记并导致生成失败。
- **持久化声明双向错配复现**（用真实 Worker 实测两种方向）：
  - 清单声明需要存储、工厂未开启 → 现行实现仍启动成功（App 未拿到存储）；
  - 清单未声明存储、工厂开启了 → 现行实现仍启动成功（App 拿到了存储）；
  - 根因是 [manifest.ts](../../runtime/src/engine/app/manifest.ts#L47) 校验了 `persistenceSupport` 但未透传，[worker-runtime/index.ts](../../runtime/src/worker-runtime/index.ts#L214) 目前只核对 `app_name`、尚未核对持久化声明。
- 默认 Node Worker 无法强制拦截 App 访问本地文件系统、网络或子进程。

### 2. 已修正/撤回意见
- 纠正初稿“启动时 Worker 已有 `persistenceSupport` 核对”的现状误判：经真实 Worker 复现，目前仅核对 `app_name`，持久化双向核对须在实现阶段补齐。

### 3. 已确认决策
1. **选定 1A：以 `package.json` 为唯一手写源，纯静态生成 `aoapp.json`**：
   - `package.json` 沿用已有 `version`、`main`、`types`、`description` 等字段，新增 `aotui` 小节只填 App 专有信息（如 `app_name`、`whatItIs`、`whenToUse`、是否需要框架存储）；App 代码与生成器共用同一份声明。
   - `generate-aoapp` 只读静态文件并检查声明与入口文件存在，由 SDK 填入协议标识并自动产出 `aoapp.json`，**彻底不 `import()` 业务模块**。
   - 默认导出写错与 App 实际能否启动，交由发包测试用真实 Worker 打开一次验证，作者仍只需一个生成命令。
2. **最小字段集与双向持久化核对**：
   - 清单只保留三类信息：**这是什么 App**（发现元数据）、**从哪里打开**（`entry`）、**需要哪些框架能力**（协议与能力标识）。
   - 生成器从 `@aotui/core` 薄根入口取公共协议常量，改为静态生成后直接移除原用于检查工厂的私有辅助函数（去掉对 `@aotui/core/internal` 的依赖）。
   - **补齐持久化双向核对并区分裸模块**：有 `aoapp.json` 清单时，把持久化声明（含“有清单但未声明”）传到 Worker，与工厂实际声明逐项核对，**任一方向错配均在业务初始化前拒绝报错**；无清单的裸模块保持 `SYS-03` 已定规则，由 Worker 读取工厂后按需申请存储。
3. **权限边界：暂不加 `fs / net / shell` 等 OS 权限字段**：
   - 判据：“如果 App 没写 `fs`，Runtime 能拦住它读文件吗？”默认 Node Worker 拦不住，因此不写纸面权限以免制造虚假安全预期。
   - 保留 `persistenceSupport`，因为 Runtime 确实能决定是否提供框架托管存储服务；未来有执行环境能真正强制限制文件、网络或子进程时，再引入其可落实的权限声明。

### 4. 核心验收条件
- 保留现有 9 项清单测试通过；
- 新增两项必过验收：① 生成与发现均不触发 App 入口代码执行；② 清单与工厂持久化声明的两种反向错配均在业务启动前被拒绝。

### 5. 决策记录
- **2026-11-24（已确认）**：选定 1A（`package.json` + `aotui` 小节作为唯一手写源，纯静态生成 `aoapp.json`）；补齐有清单时的持久化双向核对并区分裸模块；不加无法强制执行的 `fs / net / shell` 权限，保留 `persistenceSupport`。
