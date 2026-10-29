# ChatGPT 独立验收清单 — Codex Stage 8

**Codex 仅负责真实实施与提供日志；是否满足 Gate 由 ChatGPT 在 Codex 执行结束后独立判定。**

## 安全与保护用户工作树
- [ ] Codex 实际阅读并遵循 .agents/skills/minimalist/SKILL.md。
- [ ] git HEAD 未改变；git diff --cached --binary 的 SHA-256 始终一致，已有 staged 和 untracked 未删除、重置、覆盖或被重新加入 index。
- [ ] 未执行 git add/commit/reset/restore/clean/stash/checkout/push/rebase。现有 modified 源码只做有具体原因的精确编辑。
- [ ] Core 不引入 DOM/Preact/Worker/Node 文件系统/供应商耦合；无额外依赖、新 Tool Framework、第二个 Snapshot Store。
- [ ] 未擅自改变默认 Agent mutating 路由，不宣称 Shadow strictEligible:true。

## P0/M4 Stage 8 实际安全合同
- [ ] 入口请求必须在任何 await 之前严格复制/冻结，拒绝 getter、非 JSON 和未授权字段；真实 Worker 测试异步授权期间参数变化时执行内容/目标不漂移。
- [ ] Host close single-flight；APP_SHUTDOWN/APP_CLOSE 不重复；WorkerPool RESET/terminate 等在途磁盘操作；open/pause/resume/reinitialize 关闭时拒绝；关闭失败不留下半关闭状态。
- [ ] 未授权的文件/Tool 不能调用 Adapter；delete_file 不能调用 replace_file；历史 ViewInstance、Tool binding、同名 Ref 的错误目标均 fail closed。
- [ ] 成功磁盘写入不被视作失败；内容不变也不得重放；Adapter 已写但返回异常必须 outcome unknown 并阻止盲目重试。
- [ ] SDK/Worker 捕获期间 Epoch 变化导致 Prepare Failed、不发布 torn Draft，并能在稳定版本恢复。
- [ ] 真实运行记录证明至少双 FileDetail/同名 Ref Tool 不会误写另一文件。
- [ ] 对外没有把 producerConsistency=unverified/strictEligible=false 升为 GO。
- [ ] 不夸大合作式文件锁对不合作外部进程的 OS 全局 CAS、不忽略文件 hash ABA/inode/ACL/xattr 或 crash lock。

## 强制命令与独立复验
- [ ] runtime tsc exit 0
- [ ] sdk tsc exit 0
- [ ] IDE tsc exit 0
- [ ] Runtime 全部 Vitest exit 0
- [ ] SDK 全部 Vitest exit 0
- [ ] IDE 全部 Jest exit 0
- [ ] 至少 3 轮真实 Worker 相关测试 exit 0（有原始日志）
- [ ] 每个新增测试有清晰真实失败场景；禁止 skip/todo/放宽 tsconfig/篡改断言
- [ ] Stage 8 CODEX_RESULTS.md / GATE_STATUS.json / 原始 test 日志 / source-fingerprints.json / NEXT_WAVE_RECOMMENDATION.md 均可实际读取
- [ ] 我独立检查 diff、数据结构和安全边界，不只依据 Codex 自己生成的结果总结
- [ ] 我独立检查 baselineIndexSha256 === finalIndexSha256，HEAD 与用户既有工作树不被错误清理。

## 签署条件

所有必需项都真实通过，才允许我签“Stage 8 limited PASS”。即使 limited PASS 也不能称完整 M4 / P0 / Strict 全部准出。无法验证的项目明确保留 NO-GO 和下一步最小方案。**Codex 在提交证据后暂停，后续 Wave 2 需要单独验收批准。**
