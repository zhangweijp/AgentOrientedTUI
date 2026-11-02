# 默认 Semantic Host 验证记录 — 2026-10-28

## 交付范围

默认 Electron Host / SessionManager 使用通用 `SemanticAOTUIDrivenSource`，IDE、Terminal、Browser 通过标准 AppRegistry 安装。IDE 专用测试 Source 和开发环境变量分支已移除。Desktop、Worker 和 App 生命周期基础设施继续复用；Legacy 公共 API 与旧实现待项目所有者验收后清理，默认交互不回退。

这次验证针对当前本地工作树，没有发布 npm 包，也没有执行全仓全部历史测试或性能基准。Electron 主进程和 preload 已构建；真实模型验证覆盖正常 Host 后端，未代替人工操作 Electron GUI。

## 已通过的验证

| 范围 | 结果 |
| --- | --- |
| Driver、Runtime、SDK、IDE、Terminal、Browser、Host 构建 | 全部通过；Host 在最后消息通知修复后再次构建通过 |
| Observation / Scoped Interaction / Snapshot / Retention | 449 项通过 |
| AppRegistry 与角色配置 | 25 项通过 |
| 通用 Semantic Source 与执行能力过滤 | 20 项通过，包括多 App、300 轮释放、五态映射 |
| Worker 能力协商、Scoped Invocation、普通 V1/V2 调用 | 126 项通过 |
| Driver 原子 Context、执行、状态机 | 24 项通过，1 项既有跳过 |
| Host 安装、会话控制、持久化收据通知 | 21 项通过 |
| IDE 正常 AppContext 配置 | 3 项通过 |
| 默认 Host 多应用真实 Worker 链路 | 7 个场景通过 |
| 完整 Scoped IDE 业务回归 | 6 个场景、39 次调用通过 |
| 真实 DeepSeek + 默认 SessionManager / Driver | 4 次真实请求、3 个成功工具回执，全部最终断言通过 |

定向单元与集成测试合计 **668 项通过、1 项既有跳过**；上述两个独立 E2E 脚本及真实模型验收另列，不计入这 668 项。

## 默认 Host 多应用链路证明了什么

`host/test/semantic-host.e2e.ts` 使用真实 Runtime、Worker 和三个应用的默认入口；在调用前将 `kernel.acquireSnapshot`、`kernel.execute`、`desktop.getSnapshotFragments` 设为抛错。测试没有 Semantic 开发开关。

- 初始没有 FileDetail 编辑工具；打开文件后，下一次观察立即包含内容和文件所属工具。
- 将同一观察实际持有 **31 秒** 后，普通 V1 的 `read_loaded_diagnostics` 仍成功。
- 编辑后，下一次观察只有更新后的正文，旧正文退出当前应用投影。
- 关闭文件、重新打开同一路径后，原 FileDetail Binding 均被拒绝，不重新绑定到新实例。
- Terminal 通过所属 View 的工具启动命令、读取输出并关闭；关闭后的旧绑定拒绝执行。
- Browser 从标准 pending 安装状态打开，抓取本地 HTTP fixture，关闭页面后旧绑定拒绝执行。

完整 IDE 回归另外验证了实际 TypeScript 的七种 LSP 查询、诊断更新、同内容 inode 替换后的写入拒绝、顺序批量编辑、重命名身份、删除、持久化恢复、资源释放和物理 Worker 复用。显式 Legacy 隔离测试保留用于当前迁移阶段，不属于默认 Host 路径。

## 真实模型事实

`host/test/semantic-host-llm.e2e.ts` 通过正常 `SessionManagerV3 → AgentDriverV2 → SemanticAOTUIDrivenSource` 运行，使用标准 AppRegistry 的默认 IDE。脚本只创建临时 fixture，不替模型调用业务工具。

| 请求 | 模型实际收到的当前状态 |
| --- | --- |
| 1 | 有打开文件工具；没有编辑、已加载诊断工具；没有文件正文 View |
| 2 | 一份 `answer = 42` FileDetail；编辑与诊断工具可见 |
| 3 | 仍只有当前 `42` FileDetail；此前只读诊断收据已进入会话 |
| 4 | 一份 `answer = 43` FileDetail；没有旧 `42` FileDetail |

`multi_open_file`、`read_loaded_diagnostics`、`edit_file` 的 Receipt 都为 `succeeded / entered-returned`。最终文件内容确认为 `export const answer = 43;`，模型最终回答包含 `SEMANTIC_OK answer=43`。Legacy 调用次数为 **0**，清理错误为空，总耗时约 **6.2 秒**。

配置只读获取；凭据仅保留在内存，未写入临时会话数据库，也未改变用户当前模型配置。该数据库的 LLM 配置表最终仍为 0 行。

首轮脚本在 180 秒等待上限退出，当时业务工具与最新 View 已成功，但最终回答未通过整段精确相等检查。后续版本记录最终消息的安全诊断字段，并允许标记前后有解释；实际文件、View 唯一性、Receipt 和 Legacy 零调用检查全部保留。最终成功来自模型真实执行，不是手工补操作。

## 如何复现

从仓库根目录启动正常产品路径：

```bash
./run.sh
```

多应用确定性验收不需要模型凭据：

```bash
pnpm -C host exec tsx test/semantic-host.e2e.ts
```

真实模型脚本需要现有配置数据库的绝对路径与一个新结果文件路径，默认选择其中已配置的 DeepSeek；`AOTUI_TEST_PROVIDER` 可指定其他兼容配置。脚本不修改配置数据库。

```bash
AOTUI_TEST_CONFIG_DB=/absolute/path/to/chat.sqlite \
pnpm -C host exec tsx test/semantic-host-llm.e2e.ts \
  /absolute/path/to/new-semantic-host-facts.json
```

## 仍然明确保留的边界

- 标准 Source 当前没有大 App 的通用分批 Observation；容量上限及后续方向见[接入契约](./semantic-host-integration.zh-CN.md)。不能把 IDE 的最大文件数解释为模型上下文的保证。
- Scope 内去重、Receipt 保留与后台业务完成是不同保证。标准 Source 不提供跨轮持久 Receipt 查询，不承诺跨轮、跨进程 exactly-once，不自动重放 unknown 写入。
- 本轮没有升级 npm 发布物、运行全量性能基准，也没有完成 Electron GUI 的人工交互验收。
- 以上结果不是项目所有者的验收。完成本人测试验收之后，才进入已约定的 Legacy 与实验遗留代码删除阶段。

## 后续状态（2026-10-30）

项目所有者已亲自测试并验收 Semantic 路径。上文记录的是 2026-10-28 的验证状态与当时边界；后续清理按本次验收条件执行。该验收不补记当时未运行的 Electron GUI、完整性能基准或 npm 发布验证。
