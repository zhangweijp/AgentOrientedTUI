# M4 前置：ViewInstanceId / View-owned Tool 纯 Core 合同验证

- **状态：M4-preflight Stage 0 PASS；M4 正式执行/Strict NO-GO。**
- 本地 HEAD：789ef07；Node v23.11.0；pnpm 10.15.1；2026-10-22。
- [方案 B 提案](../07-view-owned-tool-identity-proposal.md) · [M3 实施报告](../m3/RESULTS.md) · [阶段计划](../04-plan.md)

## 1. 本轮设计决议

继续采用方案 B：开发者保留可读 viewId；Runtime 为每次成功挂载分配新的 viewInstanceId；Tool Handler 由声明它的 View 实例拥有。Runtime 将同一个 App、ViewType、ToolName 的公开工具聚合为一条描述，并按来源的具体 View 实例选择活态 Handler。

**此阶段刻意只新增 2 个文件**：
- runtime/src/core/tool/view-owned-tools.ts：纯 TS、内存 View 实例及实例级 Tool 注册/聚合/调用的候选 Core 实现。
- runtime/src/core/tool/view-owned-tools.test.ts：19 项与 DOM、Worker、SDK、模型无关的行为合同测试。

没有修改原来的 AppKernel、SDK、Worker、IDE、M1 Snapshot Core 类型或 Runtime 对外 package exports。未引入新依赖；严格 JSON Schema 防御性复制与 canonicalJson 直接复用 M1 Snapshot 工具，OperationResult 复用现有 SPI 类型。

## 2. 最小语义模型

只固定三个 View 概念：

- **viewId**：开发者填写、Agent 看得懂的公开名称。同一 App 内当前同时挂载的 View 不允许重复。重挂载可以重用相同 viewId；历史观察不能随之重新绑定。
- **viewType**：FileDetail、Workspace 等类型，供公开 Tool 合并。
- **viewInstanceId**：Runtime 内存注册处根据可信 AppInstanceId 和单调挂载序列生成的内部 Token。同一个 View 重绘不换实例；卸载重挂载必换实例。它不是提供给 Agent 的业务参数，也不是密码或独立权限凭据。

候选 Core 用一张 Map<ViewInstanceId, Map<ToolName, Registration>> 存活态 Handler。无需额外 ToolDefinition/ToolBinding 类、持久化 ToolID 生成器、插件/基类框架。每次注册只有一个拥有者。

- registerTool：每个 View 实例独立注册。相同实例的重复名称明确拒绝，不覆盖之前的 Handler。
- setEnabled：某实例的 enabled 改变不会影响其他 FileDetail；每次实际切换都会更新内部 bindingVersion。
- unmount：只关闭指定 viewInstanceId。旧清理回调无法删掉新挂载的同名 View。
- listTools：按 App / ViewType / ToolName 聚合一个公开定义，并保留可用目标的 viewId、viewInstanceId、bindingVersion 的内部元数据。结构深度冻结、没有 Handler。
- invoke：根据来源观察中选定的 viewInstanceId 和 bindingVersion 执行，不会按最新 viewId 偷偷转向其他文件；Handler 业务 success:false 原样返回。
- 同组 Tool 若 description、inputSchema 或 isMutating 不一致，返回 TOOL_SCHEMA_CONFLICT，不选第一个也不重命名。
- JSON Scheme 输入在注册时复制成不可变的普通数据并限制字节、深度、节点数；对象 getter 不允许作为可执行元数据进入 Core。

**bindingVersion 不是第四个 View 身份**：它只表示某个实例下某次 Tool 注册/可用性版本，保证同一个 View 中 Tool 重新注册后也不能悄悄继承历史调用。Agent 不需要知道它。

### 2.1 尚未实施的来源验证

上述 invoke 是纯 Core 内部预演。传入的 Tool 和目标必须由未来 M4 适配器从**已经验证并固定的 Runtime AppSnapshot**读取，不可信的任意 Tool JSON 不能直接成为授权。当前 Core 还没有把这套实例级绑定写入 M1 的 ToolDescriptor Schema，也没有替换正式 Worker IPC。外部副作用仍必须做实时权限/业务版本 CAS 验证。

特别地，异步 Handler 如果在合法启动后 View 才卸载，无法靠 ToolRegistry 回滚已开始的副作用；本轮测试只证明它不会**重新转发给另一个 View**。取消、并发与业务状态版本由 M4 再定义。

## 3. 已执行的合同场景

19 个测试覆盖：

1. 开发者公开 viewId 与内部 viewInstanceId 独立；同名卸载重挂载的 ID 不复用；重复活跃 viewId 拒绝。
2. 两个 FileDetail 同名 Tool 分别执行两个 Handler，Agent 聚合视图只看到一条工具描述。
3. A 注销后不会误删 B；旧 A 的观察不能变成 B 的操作。
4. View 在同名重开后，旧视图/旧 Handler 不能复活；不同 App 运行实例不共享身份。
5. 单实例 enabled=false 只禁用它自己；重新启用后旧 bindingVersion 失效。
6. 同组 Schema 对象属性顺序不同但语义相等时可聚合；Schema/description 不同明确拒绝且无部分写入。
7. 相同 View 实例重复注册同名 Tool 拒绝；旧 cleanup 不影响新 View。
8. Handler 业务失败原样传播；抛异常形成失败；非标准返回形成 TOOL_RESULT_INVALID。
9. 跨来源 Tool ID 或目标实例篡改拒收；参数形状不合法拒收。
10. Handler 不进入公开描述、参数 Schema 与原开发者对象断开引用并深度冻结；元数据 getter 不执行，未知字段/非 JSON Payload 被拒。
11. 80 个 FileDetail 各自持有 Handler，仅聚合一份公开 Tool，正确定位具体第 64 个 Handler；卸载偶数项后剩余不受影响。
12. 正在运行的异步 Handler 即使其所属 View 后来关闭，也不会把返回转发到新挂载的同名 View。

## 4. 真正执行的验证结果

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| 新 Tool 纯 Core 合同 | **19 passed**、1 file，exit 0 | [核心覆盖率日志](./core-coverage.log) |
| 新 Core 代码覆盖率 | Statements/Lines 97.02%，Branches 91.95%，Functions 100% | [核心覆盖率日志](./core-coverage.log) |
| Runtime TypeScript | exit 0 | [最终回归](./final-regression.log) |
| Runtime 完整 Vitest | **54 files / 471 passed、3 skipped、7 todo**，exit 0 | [最终回归](./final-regression.log) |
| SDK TypeScript | exit 0 | [最终回归](./final-regression.log) |
| SDK 完整 Vitest | **8 files / 72 passed**，exit 0 | [最终回归](./final-regression.log) |
| IDE Jest | **3 suites / 5 passed**，exit 0 | [最终回归](./final-regression.log) |

M3 结束时 Runtime 452 passed；本阶段只新增 19 项，合计 471。SDK/IDE 不需要迁移，原有用例维持通过。覆盖率只统计这个新 Core 文件，不代表全部 Runtime。

第一次新增用例运行的 5 个失败来自 Vitest 不接受函数形式的 toThrowError Matcher；改为匹配带错误码的异常消息后全部正常。此改动没有放松身份、结果或安全断言。

## 5. Minimalist 原则审查

- **YAGNI**：本阶段不引入复杂 ToolDefinition/Binding 类库、不添加新 SDK Hook API、不做 IDE Tool Handler 重写。
- **Reuse**：使用已有 AppInstanceId 和单调序号拼出 ViewInstanceId；复用 M1 copyJson / canonicalJson、现有 OperationResult。
- **Stdlib**：仅使用原生 Map、Object.freeze、Promise、JSON.stringify，没有增加依赖。
- **Minimum diff**：只增加纯 Runtime Core 两份 TS 文件与方案文档/执行证据。未改现有生产执行链。

## 6. 下一道 Gate（不能跳）

**Stage 0 合同 PASS，不代表完成 M4。** 下一步应实现最小 Worker/SDK 适配并分两段逐项验收：

1. 让 Runtime 实际在 View 挂载时分配 viewInstanceId；SDK 能从当前 View Context 自动获得该 ID，并在 View 内调用兼容的 useViewTypeTool；正式 AppKernel Registry 不再因相同 ViewType/ToolName 导致覆盖/误删。保持原五参数 Tool API 的兼容转接。
2. 先使 Snapshot 真正保存 Tool 的来源实例绑定事实，再从 Core 的 pinned AppSnapshot 验证 Agent 的可读 viewId 对应哪个 viewInstanceId；用这个内部身份选择活态 Handler 并复核有效性/权限/业务版本。**最后**替换默认旧调度和修复 ToolResult success:false 失真。

其中真实 IDE 的 fd_index 公开号必须在挂载生命周期内稳定；不能继续以当前数组位置作为权威执行身份。不同 ViewType 同名 Tool、同类型多实例异步销毁、Root Tool 与 FileDetail Tool 同时存在的情况下都须正确。

正式运行路径未切换、M1 Snapshot Schema 尚未迁移、Tool Handler 真实权限和结果包装尚未修复，因此 **Strict 仍为 NO-GO，原始 P0 尚未正式关闭**。

本轮不 stage、不 commit、不 reset 任何用户已有未提交修改。