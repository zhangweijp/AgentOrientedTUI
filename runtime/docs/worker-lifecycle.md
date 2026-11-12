# Worker 与 App 资源归属

每个本地 App 实例由一个 AppWorkerHost 创建并持有专属 Node Worker。业务入口在该线程中加载，静态发现读取 manifest。重开和重初始化创建新实例。Core 不依赖 Worker 或 Node。

## 容量与配置

```ts
const runtime = createRuntime({ worker: { maxWorkers: 4, timeoutMs: 30000 } });
```

| 配置 | 默认 | 范围 |
| --- | --- | --- |
| `worker.maxWorkers` | 10 | 1–100 安全整数 |
| `worker.timeoutMs` | 30000 ms | 1000–300000 ms 安全整数 |

`maxWorkers` 取代旧配置中的 `worker.pool.maxSize`。预热与空闲 Worker 配置已退出。一个 Runtime 的多个 Desktop 共享名额，不同 Runtime 各自计数。独立 AppManager 也拥有自己的限额。App 启动配置可以传递到 Host/Worker，不能改变父级 Runtime 的总容量。

线程创建前先占一个名额。构造失败撤销该次预留，已创建线程等实际退出才归还。满额时拒绝启动，容量原因是 `WORKER_CAPACITY_EXCEEDED`，由安装入口包装为 `INSTALL_FAILED`。自定义 Worker 脚本路径按启动方工作目录解析。

`defineRuntimeConfig` 接受普通或 null-prototype 对象上的自有、可枚举数据字段。访问器、未知字段和无效值以 `CONFIG_INVALID` 拒绝，诊断给出字段路径。省略或显式传 `undefined` 使用默认值。

## 关闭顺序

1. Sandbox 接受首次 close 或 delete 后同步停止准入。重复关闭加入同一过程。迟到的安装结果无法恢复运行。
2. Host 发送 `APP_STOP`，调用 App 已注册的同步 `stop`。初始化后才注册的 owner 也会立即停止。进行中的 Tool 保留原执行记录。
3. 正常路径等待 Tool 终态，随后按首次意图执行适用的 `onDelete`、持久化 flush、unmount、App cleanup 和 dispose。删除失败会被记录，后续清理仍尝试。
4. 超过 `worker.timeoutMs` 的宽限期后，Host 请求终止并记录 `APP_CLOSE_DEADLINE_EXCEEDED`。自然 `exit` 或原生 `terminate()` 成功完成提供同一个真实退出事实。终止请求或 Worker 单独报错时仍保留线程名额和必要关联。
5. Host 等待已经接纳的存储访问、adapter release 以及 Core 交互清理。后台持久化 I/O 可以在 Worker 退出后继续，原 Host 仍负责其收尾。

内部 `AppWorkerHost.close()` 等到线程实际退出。内部 `waitForResourceRelease()` 等到 Host 的资源释放尝试结束。Public Runtime 的关闭 handle 汇总 App、Worker 和存储结果。独立调用方可以通过 `wait({ timeoutMs })` 截止等待。详情见 [Runtime 关闭与结果报告](runtime-shutdown.md)。

`app-lifecycle-v2` 以 `state` / `issues` 报告 App 清理。应用的 `stop` 和 `close` 可选，卸载仍保留已经注册的 cleanup。强制退出时缺失或未完成的回调会体现在报告中。App 创建的子进程、远端任务及外部业务效果由应用或实际 adapter 处理。见 [ViewType Tool 与应用清理](tool-lifecycle.md)。

## 资源释放失败

原 Host 保留 adapter 尚未释放的存储 owner。对同一 App 重复 `desktop.closeApp(appId, expectedInstanceId)`，或对仍保留 owner 的 Desktop 重复 `runtime.beginDesktopShutdown(desktopId)`，可以显式继续释放。该尝试共享在途 release，沿用首次关闭的清理与写入结果。首次报告保持原样，后续报告体现新的资源释放事实。默认 Node adapter 按资源身份重试安全清理。见 [实例持久化](persistence.md)。
