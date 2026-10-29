# Semantic Kernel 验证记录

验证日期：2026-10-19 Asia/Shanghai（2026-10-18 UTC）。  
设备：项目所在 macOS arm64。  
项目 HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`。  
范围：`experiments/semantic-kernel`，独立安装、类型检查、测试、构建和包消费。

## 结论

**26 项测试通过，2 个测试文件通过，0 失败。** 其中一项性质测试包含 250 组生成的操作序列。TypeScript 检查、ESM / 声明构建、业务演示、独立 tarball 消费和公共类型边界检查全部通过。

该结论适用于这个无 GUI、无真实模型请求、无数据库的技术切片。现有产品的 Runtime / SDK / Driver / Host 尚未切换到该实现；这些结果不代表旧实现的问题已经修复。

## 实际运行版本

以下版本同时核对安装后的 `package.json`；Node 直接运行 `--version`：

| 依赖 | 实际版本 |
| --- | --- |
| Node | 24.22.0 |
| TypeScript | 7.0.2 |
| Effect | 4.0.5 |
| @standard-schema/spec | 1.1.0 |
| Zod | 4.6.7 |
| AI SDK / ai | 7.0.143 |
| MCP client / server / core | 2.3.1 |
| Vitest | 5.0.5 |
| fast-check | 4.10.2 |
| @types/node | 24.10.2 |
| pnpm | 10.15.1 |

Node 使用官方 `node-v24.22.0-darwin-arm64.tar.xz`，对照官方 `SHASUMS256.txt` 校验后在项目验证进程中使用。

- Node archive SHA256：`75ddfb875bbd868ebe57536f4442225f54dd10f6d2178dd439de869a5c648dc3`
- `pnpm-lock.yaml` SHA256：`c83f74ee5ed12f9026417369d599e47756c02a9e74f66dc096ef30e5f590d6fe`

## 命令与结果

| 检查 | 实际命令 / 方法 | 结果 |
| --- | --- | --- |
| 安装 | `pnpm install --ignore-workspace --ignore-scripts` | 成功，使用独立 lockfile |
| 锁文件复现 | `pnpm install --ignore-workspace --ignore-scripts --frozen-lockfile --offline` | 成功，解析被跳过，依赖一致 |
| 类型检查 | `pnpm run typecheck` | exit 0 |
| 契约测试 | `pnpm run test` | exit 0；26 / 26 |
| 构建 | `pnpm run build` | exit 0；生成 ESM、声明及 source maps |
| 演示 | `pnpm run demo` | exit 0；实际业务状态符合预期 |
| 包构建 | `pnpm pack --pack-destination <temporary-directory>` | 成功 |
| 独立消费 | 干净临时项目离线安装 tarball 与 Zod | 成功 |
| 消费端类型检查 | TypeScript 7，strict，`skipLibCheck: false` | exit 0 |
| 消费端运行 | 只通过已安装包的核心 exports 导入并执行 | exit 0 |
| 公共类型边界 | 检查 index / kernel / contracts 声明的 imports | 不含 Effect、AI SDK、MCP、React、Preact |
| Source map 交付 | 解开最终 tarball，逐一检查 map 引用的源码存在 | 12 个 map 全部通过；源码随包包含 |

核心测试的编译配置使用 `skipLibCheck: true`。独立消费端另外使用 `skipLibCheck: false` 验证核心公共入口可达的声明图；这不等于对所有适配器声明和所有 TS 历史版本都做了检查。

## 18 项内核测试

1. 列表重排后，原绑定仍完成原任务。
2. 目标资源已修改时拒绝；同一观测中的其他未修改资源仍可执行。
3. 对象已删除时拒绝，不重新绑定到剩余行。
4. 同 ID、同数据删除后重建，旧版本仍被拒绝。
5. 生成重排与无关对象编辑序列，最终仅完成原目标。
6. 同类视图实例独立撤销；关闭后重开不能复活旧绑定。
7. 业务拒绝原样保留，不包装成外层成功。
8. 并发相同调用只进入一次处理器；不同输入复用 ID 报冲突；完成后重试复用结果。
9. 观测超时不产生业务效果。
10. 观测淘汰后拒绝旧观测，新观测仍可使用。
11. 异步输入验证期间关闭视图，进入执行器前再次检查并拒绝。
12. 异步输入验证期间 TTL 到期，进入执行器前再次检查并拒绝。
13. 已进入处理器后外部取消，返回 unknown，并释放运行时作用域。
14. session.close 发出取消、释放视图订阅，并拒绝新调用。
15. Zod transform：发布转换前的输入 Schema，处理器得到转换后的值。
16. 无法表达的 bigint 输入在动作定义时失败。
17. 调用记录到达容量后拒绝新 ID，仍保留已有请求的结果。
18. 异步 finally 可以晚于取消结果完成；测试等待自己的应用清理结束，明确作用域与外部工作的区别。

性质测试使用固定 seed `20261019`、`numRuns: 250`，每组最多生成 30 步操作。生成范围是列表排列及对非目标对象的修改；视图关闭、撤销和重开由定向测试覆盖。断言包含真实 TaskRepository 最终状态、目标集合、写入次数和订阅释放，不只检查工具返回值。

## 8 项真实 SDK 适配测试

- AI SDK 7 的 `ToolLoopAgent` + 官方 `MockLanguageModelV4`：一次工具请求、真实工具执行回调、第二轮文本响应。列表在观测后重排，实际写入仍只影响原任务，并保留原 observationId、bindingId、toolCallId。
- MCP Client / Server + InMemoryTransport：tools/list、observe、execute 和相同调用重试，实际写入只有一次。
- MCP：旧资源版本和跨会话观测都被拒绝。
- MCP：分别验证 rejected、failed(partial)、unknown、accepted 四种结果完整透传。
- MCP 当前协议入口：`createMcpHandler` + `StreamableHTTPClientTransport`，fetch 直接路由到 handler；实际协商版本断言为 **`2026-07-28`**，并执行一次业务写入。

MCP 两种 transport 均在进程内运行，没有开放网络服务。AI 测试没有调用真实模型、消耗模型 Token 或读取模型密钥。

## 演示与消费端业务结果

演示先观察 task-a，然后把 task-b 重排到第一行：

```json
{
  "completion": "succeeded",
  "duplicate": "same recorded succeeded result",
  "conflict": "rejected / STALE_RESOURCE",
  "actualCompletedTask": "task-a",
  "taskBModifiedByThisAction": false,
  "writes": 1,
  "afterCloseActiveCalls": 0,
  "afterCloseSubscriptions": 0
}
```

以上是原始演示输出的字段摘要。task-b 的标题由测试中的另一个操作者修改，旧观测发起的完成动作被拒绝。

独立消费端从 tarball 安装后，通过核心 exports 定义 Zod transform 动作，把字符串 `"21"` 转换后计算为 `42`；相同调用重试后，处理器写入次数仍为 `1`。关闭后运行时 activeCalls 为 `0`。

## 本轮发现与修正

首轮 TypeScript 检查通过，但测试发现 Zod 4.6.7 的 JSON Schema 导出带不可枚举的 `~standard` 元数据。严格 JSON 复制误将元数据当作模型输入字段而拒绝。修正为专门归一化 Schema 的可枚举数据字段，再严格复制冻结；业务输入与观测的数据限制保持严格。

静态复核还修正了关闭时先 abort、后保存等待列表的顺序问题，并追踪已经撤销但仍在清理的视图。取消边界通过额外测试明确：运行时作用域释放不证明任意外部 Promise 的 finally 已结束。

## 尚未证明的能力

- 真实模型任务成功率、Token 成本、延迟收益、供应商 Schema 子集和多步刷新观测。
- 浏览器、React / Preact、Worker / IPC、Electron 打包以及其他操作系统兼容性。
- 数据库 CAS、持久 InvocationStore、掉电恢复、跨会话幂等和分布式 exactly-once。
- 不受信任插件权限隔离、网络暴露时的身份与授权。
- 大数据量、长时间运行、内存占用和吞吐性能；当前数量上限不是完整的资源预算。
- 对任意 handler 进行强制停止或自动撤销已发生副作用。

## 仓库完整性

对照开始工作时保存的基线，原有 tracked diff、staged diff 和既有文件的 Git 状态一致。新增内容位于 `experiments/semantic-kernel` 与 `rfcs`。现有产品代码和依赖锁文件的变更未被本轮验证覆盖或替换。
