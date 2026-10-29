# Stage 8 本轮审查与最小变更范围

本轮基线完整阅读 00–07 与指定 M3/M4 阶段报告；现有源码优先。基线 Runtime 538 passed / 3 skipped / 7 todo，SDK 86 passed，IDE 27 passed，三处 TypeScript exit 0。Stage 7 的 536 是历史数；额外 2 项 lifecycle 测试及请求 copyJson/closePromise 已存在于本轮起始工作树，不能归为本轮实现。

## 计划触碰的文件

- runtime/src/engine/app/worker-host.ts：关闭与 RESET 的单飞协调、正常 APP_CLOSE 后归还物理 Worker、已在途 lifecycle 响应与关闭竞争、未知适配器结果和并发同版本替换的重放边界。生产变更只在 Host 执行适配器。
- runtime/src/engine/app/worker-host.m4-lifecycle.test.ts：保留已有 8 项断言，增加可控 Promise gate 的关闭/RESET/旧响应回归。修复前真实运行得到 6 failed / 8 passed，原始日志 test-red-lifecycle.log。
- runtime/src/engine/app/worker-host.m4-versioned-file.test.ts：补请求 getter/Proxy/尺寸/异步选择与内容变更的真实 SDK+Worker 验证；将已有 1800ms Tool 变更定时器换为受控外部事件。
- runtime/src/engine/app/worker-host.m4-stage8-outcome.test.ts（计划新增）：只用真实 Core Store 和 mkdtemp 文件验证写盘后非法响应、同哈希并发请求的失败关闭；Worker 身份链另由真实 Worker 测试验证。
- 最终验收复核增加 runtime/src/core/tool/versioned-file-integration.test.ts：现有同名双 View 用例只实际写入 B 并验证 A 不变；补齐任务书指定的 A 写入后 B 不变方向，只加真实文件系统断言，不改 Core 实现。
- 本阶段证据目录与要求的五份验收文件：保存命令、退出码、原始输出、增量指纹与边界。

## 只审查、复跑的范围

Worker IPC、AppKernel、SDK View/Ref/Tool 挂载、Projection Epoch pre/post 检查、DOM Producer、唯一 Core Store、Source Lease、IDE 文件 CAS 与同名双 View 隔离。优先复用已有正确逻辑和负例；不新增第二套 Snapshot 或 Source 契约。

## 保持的 Gate

不改默认 Agent Router；实验开关仍默认关闭；Shadow 始终 unverified / strictEligible=false；不实施 Wave 2。文件 CAS 的不合作写入者、哈希 ABA、元数据与崩溃边界保持 NO-GO / 限制说明。索引指纹必须维持 258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54。
