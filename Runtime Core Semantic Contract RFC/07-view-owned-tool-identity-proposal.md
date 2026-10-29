# RFC 草案：ViewInstanceId 与 View-owned Tool（M4 前置设计决策）

状态：**方案 B 已确认；Stage 1 SDK/Runtime 实例级注册和 Stage 2 V2 Shadow 通过；正式 Agent Tool 调度和 Strict 尚未准出**。

原则：少一个公开抽象，少一层间接寻址；按实例拥有能力，按类型聚合展示，按来源快照验证执行。

## 1. 当前代码事实（仅以 TS/TSX 实现为准）

| 链路 | 代码位置 | 当前行为与真实限制 |
| --- | --- | --- |
| View 定义 | sdk/src/components/View.tsx | 开发者填写 viewId、可选 viewType；SDK 当前还生成 sdk_mount_N generation，非 Runtime 权威实例身份 |
| IDE View 地址 | demo-apps/aotui-ide/src/tui/SystemIDEApp.tsx | FileDetail 的公开 viewId 使用 fd_${index}；关闭前一个文件可使后一个文件重新编号 |
| Tool 声明 | sdk/src/hooks/useViewTypeTool.ts | 当前 useViewTypeTool(viewType,name,options,handler,config)，通过 useLayoutEffect 注册；enabled=false 注销；声明者 owner generation 已在 M3 记录 |
| IDE 的 Tool 归属 | demo-apps/aotui-ide/src/tui/RootView.tsx | Root 声明大量 FileDetail LSP Tool；用 file_path / view_id 查找目标，Root 也保留多种 Workspace Tool |
| Runtime Registry | runtime/src/worker-runtime/app-kernel/AppKernel.ts | Map<ViewType,Map<ToolName,Tool>>；同名新注册覆盖旧注册，任何声明者 cleanup 都可能注销另一个实例的同名 Tool |
| Tool 公开 | runtime/src/worker-runtime/index.ts | 从 Registry 导出 tool:appName-viewType-toolName 到 IndexMap，Tool Handler 本身不进入公开元数据 |
| Snapshot 组合 | runtime/src/engine/view/snapshot/formatter.ts | 收集 App IndexMap；Tool 名冲突可能追加 _2 等后缀，与稳定 Tool 身份目标不一致 |
| 旧执行链 | runtime/src/adapters/aotui-driven-source.ts、runtime/src/engine/system/dispatcher.ts、AppKernel.ts | Tool 名解析成 appId + ViewType/name，最终由 AppKernel 当前全局 Tool Registry 执行；当前会额外包装 Handler 的 success:false 为外层 success:true |
| M1～M3 Shadow | runtime/src/core/snapshot/types.ts、validator.ts、runtime/src/worker-runtime/dom-snapshot-producer.ts | 能保留 declaredByViewId/generation，但仅验证声明生命周期，**没有按目标 View 实例绑定 Handler 的正式执行语义** |

反例：App.tsx 是 fd_0，package.json 是 fd_1。关闭 App.tsx，再打开另一个文件后，原来的 fd_1 / fd_0 映射可能改变。旧快照中的 viewId 不能直接映射到现在同名 View，否则关闭文件或执行 LSP 可能选错目标。

## 2. 固定三个身份（不再增加第四套 ViewKey / Generation）

- **viewId**：开发者分配、Agent 可读的逻辑 View 地址；同一 App 内同时挂载时唯一。它可以被重新使用，但已发布的历史绑定不可因此更新。若同一已挂载 View 的 viewId 要改变，应作为新身份迁移/重挂载处理，而不是在同一执行绑定上原地换名。
- **viewType**：开发者声明的 View 类别，如 FileDetail。用于合并相同 Tool 的公开定义，不是执行目标 ID。
- **viewInstanceId**：Runtime 为每次成功启动的 View 挂载发放的不可复用、不可伪造的内部实例 Token。由现有 AppInstanceId + 单调 mount sequence 可以构造，不引入 UUID 库或独立 Generation 计数。SDK 的 View 在子组件注册 Tool 之前向 Runtime 领取并缓存 token；未完成 mount 的 token 不得成为可执行绑定。

**ViewInstanceId 取代 ViewSnapshot.generation / RefDescriptor.ownerViewGeneration / ToolDescriptor.declaredByViewGeneration 的身份含义。** 迁移中保留老字段适配，最后删除冗余身份表示。不要把 opaque viewInstanceId 当作 Agent 必填业务参数。

## 3. 三种方案

| 方案 | 改动与公开 API | 优点 | 长期缺点 |
| --- | --- | --- | --- |
| A. Root 集中注册 + 更强来源绑定 | 保留现有 useViewTypeTool(viewType,name,...)；补 Runtime viewInstanceId 与调用校验 | 当前代码变更最少，适合短期安全补丁 | Root 仍要知道每个 FileDetail 的路径/状态/工具；View 自治和动态多实例注册没解决 |
| **B. View 本地声明 + Runtime 自动聚合（推荐）** | View 内 useViewTypeTool(name,options,handler,config)；viewType 从所处 View 自动推断；兼容旧签名 | 拥有权、生命周期、Handler 绑定全在同一个 View；Agent 仍只看到每类型一份 Tool | 需要替换全局单 Handler Registry；必须检测同类 Tool Schema 不一致 |
| C. ViewType Tool 静态定义 + View 实例只绑定 | 为 ViewType 单独声明工具模板，然后每实例绑定当前状态/Handler | 模板只定义一次，适合大量插件式同类 View | 至少两套声明 API、跨文件跳转；当前需求下是提前抽象 |

**采用 B**。App/Workspace 级业务 Tool 仍归真正拥有它们的 Root 或 Workspace View。没有证据需要另造 AppTool 注册体系、ViewKey、ToolBinding 类、ToolRegistry 基类或插件框架。

## 4. 最小的 Tool 语义

Runtime 内部可沿用一个简单结构：

```ts
Map<ViewInstanceId, Map<ToolName, { description, schema, handler, enabled }>>
```

- 每个 View 自己注册、更新、注销其 Tool；注销 **只删除该 ViewInstanceId 的条目**，不影响其他 FileDetail。
- Agent 公布时按 **(App, viewType, toolName)** 聚合为一份 ToolDescriptor；不按 ViewInstanceId 生成大量模型工具名。
- 同组 Tool 的公开参数 Schema / 公共描述必须一致；冲突时报确定性错误，**不选第一份、不做后缀重命名**。每实例文件路径、LSP ready 状态属于 View 数据/可用性，不应该塞进公共 description。
- 单实例 enabled=false 只使该 View 实例不可选；只要仍有至少一个有效实例，公共 Tool 仍可被展示。
- 闭包 Handler 保留在 Runtime 的活态绑定中，**永远不进入 Snapshot**。Snapshot 记录公开 Tool 定义及来源时刻可选择的 ViewInstanceId 集合，或等价的 View→Tool 绑定事实。
- Agent 可以选公开 viewId；Runtime 必须通过来源 Snapshot 把 viewId 固定为当时的 viewInstanceId，再比对当前实例和 Tool 绑定。无来源 Snapshot 时应明确采用一个单独的 latest 策略，不能冒充历史来源。
- 真实副作用执行必须再验权、检查业务版本/资源状态。关闭重开同名 viewId 的旧调用拒绝，不允许重新映射到其他文件。
- ToolResult 必须保留业务 success:false；运输层 success:true 不得覆盖 Handler 失败。这是 M4 的原 P0 必修项。

## 5. SDK 使用方式（目标 API 草案，不是已实现 API）

```tsx
function FileDetailContent({ filePath, lspReady }) {
  const [HoverUI] = useViewTypeTool(
    'lsp_hover',
    { description: '查看当前文件的类型信息', params: hoverParams },
    async ({ line, character }) => lsp.hover(filePath, line, character),
    { enabled: lspReady },
  );
  return <HoverUI />;
}
```

通过所在 View 的 Context 自动确定 viewType / viewInstanceId；不再要求 Handler 从 args 中重新查目标文件。对于 SDK 的原五参数 useViewTypeTool(viewType,name,...)，迁移期保留兼容重载；对现有 IDE Handler **逐步迁移**，不要求一次性重写。

真正聚合的公开 Tool 仍是 system_ide-FileDetail-lsp_hover 这一类稳定逻辑名；三个 FileDetail 可以拥有三个不同 Handler 绑定，但 Agent 只见一份 Tool 描述。

## 6. M4 之前的验收门槛

1. 双 View、同类型同 Tool：两个 Handler 绑定相互隔离；关闭 A 不注销 B，且不会沿用 A 的 Handler。
2. 同 viewId 的卸载/重挂载：新旧 viewInstanceId 不同；旧 Snapshot Tool/Ref 定位必须拒绝或明确归为过期。
3. 当前 IDE fd_${index} 位置变化：必须先使用稳定公开 viewId 的生命周期策略；不能让任意数组位置成为权威执行身份。
4. 同组 Tool Schema/公开说明相同可聚合、不同则报明确冲突；单实例 enabled 只改变本实例可用性。
5. Runtime 不需要 Root 重新传递目标 file_path 才能找到具体 FileDetail Handler；真正 App 共享 LSP service 可通过 Context 注入。
6. Snapshot 不保存 Handler；Runtime 在实际操作前按来源快照绑定并复核实例/权限/业务版本。
7. 保留旧 Tool 名的兼容层通过 IDE 回归测试；严格 ToolResult 业务失败传播端到端通过。

## 7. 本轮结论与不执行范围

本文件是 **架构提案，不是 M4 已实现声明**。当前运行代码仍沿用 Root 集中注册、全局 ViewType/name Tool Map、Generation 和旧执行器，不得把方案 B 的性质归于现有生产路径。

采用方案 B 不要求大规模改写 DOM/Worker、不引入模型厂商依赖，也不需要创建复杂 Tool Definition/Binding 类库。应当先由纯 Core 双 View 合同测试驱动最小 Map 改造，再迁移 SDK View-local 声明，最后切换正式 Tool 执行与来源约束。


## 8. 已确认的方案 B：第一轮纯 Core 落地（2026-10-22）

详细实测与局限见 [M4 前置合同结果](./m4-preflight/RESULTS.md)。

**架构决议**：三个 View 身份只保留 viewId（人类可读逻辑名）、viewType（类别）、viewInstanceId（Runtime 的具体挂载身份）。不再把 viewGeneration 作为新的长期独立身份。每个 View 内注册、撤销 Tool，Runtime 按 ViewType/ToolName 聚合对外定义，并以来源快照中的 viewInstanceId 与内部绑定版本选择 Handler。

**已实现的最小 Core 验证**：runtime/src/core/tool/view-owned-tools.ts 及其同目录测试。19 项合同测试通过，覆盖 80 个 FileDetail → 一份公开 Tool、独立 Handler、来源实例版本失效、同名重挂载拒绝、Schema 冲突拒绝、业务 success:false 不变。Runtime 471 passed，SDK 72 passed，IDE Jest 5 passed，类型检查均退出 0。

现有 M1 Snapshot Store、AppKernel、SDK hook 和 Worker 的正式 Tool 执行路径都没有因此切换。**invoke 原型只允许未来可信 M4 Adapter 用已验证的 Snapshot 中的来源绑定信息调用，不能把 Agent 自报的 Tool JSON 当成授权凭据。** 这一步是纯 Core 语义验收，不是 M4 Strict 准出。

为了保护前后语义，纯 Core 另有一个**工具注册版本号 bindingVersion**：它不是第四个 View 身份，只用于区分同一 View 实例中前后两次 Tool 注册或 enabled 状态切换，防止旧观察悄悄复用新 Handler。Snapshot V1 的 generation/owner 字段需要后续版本化适配到 viewInstanceId，禁止无版本静默重命名。

**下一阶段顺序不变**：View 挂载时由 Runtime 真正分配 ID → SDK View-local 注册及兼容现有 Tool API → Snapshot 绑定来源身份 → 正式调度与权限校验 → ToolResult 正确传播 → IDE 验收。任何阶段不能直接跳过，Strict 仍 No-Go。

## 9. 已证实的 Stage 1 和 Stage 2 边界（2026-10-22）

[Stage 1 实现与测试](./m4-preflight/STAGE1_RESULTS.md) · [Stage 2 V2 Snapshot/来源选择实测](./m4-preflight/STAGE2_RESULTS.md)。

- ViewInstanceId 不再只是 M3 的 SDK generation 模拟。Runtime 真正按可信 AppInstanceId 和 mount 序列给已提交 View 分配内部实例；Stage 1 的新签名可以在 View 内声明独立的 Tool Handler，同类型由 Runtime 聚合，兼容原 Root 级 Tool。
- V2 明确与 V1 不同：viewGeneration/declaredByViewGeneration 的旧版事实不被无版本重解释。Stage 2 引入 schemaVersion=2，将绑定版本、ViewInstanceId 和每个 Tool 的精确可用 targets 作为同一份 Core Commit 内容，而不是松散的异步 metadata。
- 实际 Worker/SDK V2 Shadow E2E 已证明 Ref-only、Tool-only 和同名 View 重挂载推动新 Snapshot，历史对象/Tool 目标不漂移；四次复跑均通过。Runtime Store Lease 只读来源选择器不信任 Agent 构造的 Tool JSON。
- V2 的纯 Core 实现不等于完整正式 Tool 执行；SDK 异步/异常 Barrier、真实 LSP/IDE 业务权限 CAS、AppKernel success:false 外层包装成功修复、Schema 等价和正式性能预算尚缺失。**Strict 继续 No-Go。**

阶段顺序：Stage 1 SDK Runtime 身份/Tool 自治已通过 → Stage 2 Core V2 Snapshot/只读来源选择与 Shadow 已通过 → Stage 3 最小可信 Tool Dispatcher 与权限/失败语义 → IDE 真实工作负载准出。
