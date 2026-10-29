# Stage 8 之后的最小建议

当前仅建议 Stage 8 limited PASS，等待 ChatGPT 独立验收。本批没有执行 Wave 2，也不代表完整 M4/Strict 批准。

## 先验收本批

1. 对照 `codex-20261023T103428Z/incremental-changes.patch` 审阅本批实际增量；不要将已有请求冻结/closePromise/Stage 7 代码重复归功于本批。
2. 审阅负面测试与修复，尤其是适配器响应未知、同哈希并发写入、正常 APP_CLOSE 后 RESET，以及本批曾引入又修复的外部 exit listener 回归。
3. 核对 `GATE_STATUS.json`、最后六个 `test-final-delivery-*.log`、三份 `test-stability-delivery-*.log` 和 `test-integrity-delivery.log`。最终 Runtime 564 passed / 3 skipped / 7 todo，SDK 86 passed，IDE 27 passed；三轮各 9 files / 46 passed；双 FileDetail 同名 Ref/Tool 的实际写入隔离现已双向验证。
4. 暂存区 SHA-256 必须仍为 `258d9b26c2ac0c01d9156553bd3bd775de08ba16330546d65b5bb53b896dcf54`。若不同，停止，不自动修复 index。

## 独立批准后才进入 Wave 2

推荐先做一个边界明确的小批次：收敛 Runtime Store pinned V2 到当前 ViewInstance/Tool binding 的来源执行契约，补同名 View 重挂载、Ref-only / Tool-only、TTL/lease、旧 App 复用 Worker、Schema 冲突的真实 Worker/SDK/Host 回归，并明确 Legacy 兼容适配方式。先记录当前行为和负例，再讨论是否需要变更对外签名。

不将 Legacy write_file/edit_file/delete_file 直接接到可写 V2 路由；实验 V2 mutating 路径默认关闭，Legacy router 保持原行为。Controller 的角色/资源授权、File Adapter 的实际版本比较和活态 Tool 检查仍是必要条件。

## 后续必须单独批准的风险

- Strict Source：Projection CommitBarrier 的全面证明、可观察 mutation 的边界、SDK 重入/异常/生命周期与未通知原地突变的限制。
- Mutating Gate：Worker 验证和实际文件提交之间的生命周期竞争、可信策略/适配器异常与取消边界。确定需要持久化幂等性前，不引入第二套状态存储；当前 Host fence 不能声称跨重启 exactly-once。
- 文件 CAS：不合作外部写入者和哈希 ABA 的边界仍存在；若未来必须防护，需要独立业务版本/存储事务机制，不能更改报告措辞当作修复。
- M5/M6：真实 IDE 多文件/LSP 工作负载、最小独立非 DOM/Worker Core Adapter、CPU/heap 与 p50/p95、来源明确的性能预算。当前全部 NOT_TESTED，不能用 Vitest 耗时替代。

ChatGPT 是本批架构/质量验收方；本文件仅提出下一批最小范围和风险，不代替批准。
