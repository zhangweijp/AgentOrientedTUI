# Semantic Kernel 技术验证

这是 AgentOrientedTUI 理想架构的独立验证切片。它验证一条完整链路：**应用发布不可变观测 → Agent 选择观测中的动作绑定 → 内核验证调用 → 业务适配器按资源版本条件执行 → 调用者得到准确的业务结果**。

它位于独立目录，使用独立依赖锁文件。现有 Runtime、SDK、Driver 和桌面宿主尚未迁移到这里。技术决策及取舍见仓库 `rfcs/0001-semantic-runtime-technology.zh-CN.md`；实际运行证据和边界见本目录 `VERIFICATION.md`。

## 技术基线

| 层 | 本切片使用的版本 | 目的 |
| --- | --- | --- |
| 运行时 | Node 24.22.0 LTS | 明确、可复现的服务端运行基线 |
| 类型与构建 | TypeScript 7.0.2 | 检查公共契约，生成 ESM 和声明文件 |
| 内部资源生命周期 | Effect 4.0.5 | 管理视图订阅、调用作用域、取消和清理 |
| 输入契约 | Standard Schema 1.1.0、Zod 4.6.7 | 同时验证输入和发布输入 JSON Schema |
| Agent 适配 | AI SDK 7.0.143 | 使用真实工具回调与 ToolLoopAgent |
| 协议适配 | MCP TypeScript SDK 2.3.1 | 通过 MCP 发布观测与执行入口 |
| 验证 | Vitest 5.0.5、fast-check 4.10.2 | 验证业务后置状态和生成的变更序列 |

包管理器沿用已验证的 pnpm 10.15.1。此次不把包管理器升级与语义内核验证合并进行。生产拆包时，AI SDK、MCP 和 Zod 示例应属于独立适配包；当前单一私有包便于检验依赖组合。

## 运行

先切换到 `.nvmrc` 指定的 Node 版本，再在本目录运行：

```sh
pnpm install --ignore-workspace --ignore-scripts --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run demo
```

测试使用官方模型 mock 和进程内 MCP transport，不需要 API Key。`demo` 检查列表重排、相同请求重试、资源变化后拒绝，以及会话关闭后的订阅释放。

## 应用开发者使用的接口

公共入口只暴露普通对象、Promise、AbortSignal 和 Standard Schema 接口。Effect、AI SDK、MCP 和 UI 框架类型不会进入核心入口的公共声明。

```ts
import { createSession, defineAction } from '@aotui/semantic-kernel-spike';
import { z } from 'zod';

const complete = defineAction({
  name: 'complete_task',
  description: 'Complete the task at its observed revision.',
  input: z.strictObject({}),
  execute: (context) => repository.complete(context),
});

const session = createSession();
const closeView = session.openView({
  id: 'my-tasks',
  project: () => repository.list().map(task => ({
    label: task.title,
    target: {
      kind: 'Task',
      id: task.id,
      revision: task.revision,
      data: { title: task.title, done: task.done },
    },
    actions: task.done ? [] : [complete],
  })),
  subscribe: repository.subscribe,
});

const observation = session.observe();
// The caller selects a binding from this observation.
const item = observation.views[0]?.items[0];
const binding = item?.actions[0];
if (binding) {
  const result = await session.execute({
    observationId: observation.id,
    actionBindingId: binding.bindingId,
    invocationId: 'one-logical-attempt',
    input: {},
  });
  console.log(result);
}

await closeView();
await session.close();
```

`repository` 是应用提供的业务适配器；完整可运行实现见 `src/task-app.ts` 和 `src/demo.ts`。其中 `complete` 在同一个同步临界区内查找 ID、比较 revision 并写入。真实数据库应在自己的事务或条件更新语句内完成这个判断，不能依赖内核提前读取版本来保证原子性。

`project` 是对已经取得的一致本地状态做同步、无副作用投影。它不是异步查询 API，也不自动提供跨数据库快照一致性。

## 核心约定

### 对象身份属于观测

每份 Observation 都有独立的引用表和动作绑定表。绑定固定到当时的目标 ID、版本和拥有该动作的视图实例；列表位置改变不会改变绑定指向。

视图关闭会立即撤销它拥有的绑定。同一个 `viewId` 重新打开后属于新实例，不能复活旧绑定。输入验证可能异步让出执行，因此进入业务处理器前会再次检查观测保留状态、TTL、视图所有权与取消信号。

### 业务结果只表达一次

| status | 含义 |
| --- | --- |
| `succeeded` | 业务适配器报告操作已完成，并提供 JSON 结果 |
| `rejected` | 业务处理被拒绝，例如目标版本已变化 |
| `failed` | 已知执行失败，明确副作用为 `none` 或 `partial` |
| `accepted` | 已接收异步操作，提供 `operationId`，尚未报告完成 |
| `unknown` | 无法确认最终结果，需要查询业务事实 |

处理器进入后抛异常或遭中断，运行时保守返回 `unknown`。它不会把捕获到异常等同于“没有副作用”，也不会在外层再包一个 `success: true`。

### 重复调用与保留期限

相同 `invocationId`、观测、绑定和规范化 JSON 输入共享同一 Promise 和已记录结果；相同 ID 被用于不同请求时返回 `ID_CONFLICT`。调用记录会在执行开始前预留，防止并发重复进入处理器。

本切片的记录保存在单个会话的内存中，达到 `maxInvocations` 后拒绝新 ID，保留已有记录。关闭会话后仍可读取已有调用的结果，不能发起新的调用。跨进程重启、跨会话和远端服务的幂等性尚未实现。

观测数量、调用记录数量和诊断事件数量有上限。这只是按数量限制；单条数据大小、单次调用成本和活跃调用并发上限仍需要宿主策略。

### 取消与资源释放

Effect Scope 管理运行时拥有的视图订阅与调用作用域。关闭会话会撤销视图、发出取消信号并等待运行时拥有的清理结束。`inspect().activeCalls` 表示运行时作用域数量。

普通 Promise 不能被运行时强制终止：处理器可能不响应 AbortSignal，异步 `finally` 也可能在调用已返回 `unknown` 后继续运行。应用仍然负责外部资源清理和操作状态确认。测试刻意保留了这个边界，避免把 `activeCalls === 0` 误解为外部系统已完全停止。需要跨中断继续完成的工作，应交给可查询的持久操作并返回 `accepted`。

### Schema 的两种职责

Standard Schema 校验输入并产生业务处理器使用的值；Standard JSON Schema 发布模型实际要提交的输入形状。使用 Zod transform 时，模型看到转换前的类型，业务代码得到转换后的值。无法导出为 JSON Schema 的输入在动作定义时失败。

Schema 导出对象可能带不可枚举的库元数据，发布时只提取可枚举数据字段。业务输入、观测与结果继续使用严格 JSON 深复制和冻结，不执行访问器，不接受循环引用或类实例。

## 适配边界

`src/adapters.ts` 提供 AI SDK 和 MCP 两个实验适配器。AI 工具闭包绑定原始 Observation，用 SDK 的 `toolCallId` 标识一次调用；当前使用一个通用执行工具，动作输入 Schema 保存在观测中，由内核做权威校验。这还没有验证真实模型提供商的 Schema 限制或 Token 成本。

MCP Server 实例绑定一个 Session，提供 `aotui_observe` 和 `aotui_execute`。它完整保留 `ActionResult`，将 `rejected`、`failed`、`unknown` 映射为工具错误。测试同时覆盖内存 transport 与通过自定义 `fetch` 连接的进程内 HTTP transport；SDK 主版本与实际协商协议版本分别检查。

## 当前验证范围

这是无 GUI、无真实模型请求、无数据库的契约验证。它尚不包含权限策略、持久调用日志、Worker 进程隔离、重启恢复、React/Preact 视图适配、Electron 打包或真实提供商兼容性测试。

后续第一条产品迁移路径是：让一个现有应用通过相同业务适配器同时服务于旧 UI 与新观测入口，再验证真实 Agent 和桌面宿主。详细准入条件见 RFC。
