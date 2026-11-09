# SRT-01～SRT-15 剩余合同集中复核

2026-11-09，SRT Owner。最终结论：`APPROVED_ADOPTED`。下列唯一P2已由Clean限定修复，随后并入的facades迁移也已核对；最终118路径已经采用到实际根目录，必要安装、构建和严格类型检查通过。[完整15项验收](SRT-01_15_FINAL_OWNER_ACCEPTANCE_2026-11-09.zh-CN.md)为当前结论。下文保留首轮候选及原失败，未将它们改写成首轮无问题。

## 候选与已完成复核

候选位于 `.tmp/srt-01-15-remaining-20261109`。完整增量为113个路径，补丁 SHA-256 为 `6ce545a94e321752ec95a8759a161a43f22ff533293748af7bf5c6e1efbd85f8`。逐文件 baseline/candidate 与交付身份一致，核对时根目录113个 preimage 均匹配。身份记录见 `review-evidence/srt-01-15-final-owner-20261109/identity.json`。

本次集中复核覆盖：静态元数据发现及唯一作者来源；运行身份与持久化 namespace；ToolResult 判别联合及跨进程捕获；协议常量和 INIT/ACK；旧入口删除；相关文档、示例、skill 与普通包迁移。除下列一项外，未发现本次变更的交付阻断。没有新增第二位负责人复核。

复用 Clean 最终34项有效检查，包括 Runtime 2096项、SDK 188项、Adapter 46项、IDE 63项和相关 App／公开类型／包消费者检查。已核对最终日志与实际产物身份，不重复全量矩阵。此前已采用的 MC 清理直接沿用 MC Owner 结论。

Owner 另用正常安装的四包消费者执行真实 Worker：成功、无副作用失败、部分副作用失败、未知结果、非法结果、非法结果后的调用，六次结果分别为 succeeded / failed / failed / unknown / unknown / rejected，关闭后资源释放，保留 scope 与 bytes 均为0。独立检查退出0，用时15.489秒；原 Clean 证据未被覆盖。记录见 `review-evidence/srt-01-15-final-owner-20261109/installed-worker-run.json` 及候选 `consumer/results/owner-result-worker.json`。

## 唯一修复项：不存在的明确入口被替换

**P2，`runtime/src/engine/app/registry.ts:350–367`。** `readManifest` 在 source 目标不存在时从父目录寻找清单，而明确文件与清单入口的一致性判断仅在目标已经存在时执行。因此 `local:/有效App目录/missing.mjs` 被接受，实际解析成清单里的 `app.mjs`。拼错或已失效的明确入口应报告该路径问题，不能悄悄启动另一个入口。

已在实际安装包复现：`consumer/results/owner-missing-source.json` 记录 `accepted: true`，resolved 为 `owner-metadata-discovery/app.mjs`，输入为同目录下不存在的 `missing.mjs`。这是实测行为，不是预防性扩展要求。

限定修复：沿现有错误合同拒绝不存在的 local source；保留已有的目录安装、有效明确入口及生成清单发现。给这一分支补必要回归，重建 Runtime 包并验证安装后的相同复现转为拒绝即可。无需新增路径框架，不重跑无关全量矩阵、GUI、模型或 MC 已验收任务。

## 首轮修复指令（已执行）

Clean 完成这一修复及直接受影响验证，一次提交更新的候选身份／补丁和证据。Owner 核对修复后直接采用，更新 `deepseek_review.md` 的完整15项状态。未来 Ref字段访问、数据作用域、基础类型体系及此前明确暂缓项目仍不纳入本次完成声明；不发布、推送或合并。

## 并行开发线已批准基线

集中复核后收到MC Owner整项批准的内核第二轮减法，SRT Owner已按该唯一结论采用14路径并完成根Runtime／SDK构建，详见[SRT-15采用记录](SRT-15_KERNEL_CLEANUP_OWNER_ADOPTION_2026-11-09.zh-CN.md)。这14路径与Clean原113路径无交集，最终候选吸收为baseline，不重复计作Clean成果或再次审查。另一个实际交叉项`facades/index.ts`纯转导出退出涉及Clean已拥有的CLI、根入口及两项集成消费者，已并入同一最终修订；Owner只核对这项新增迁移及上述P2修复。

## 最终修订核对与关闭

r02-combined增量7路径：缺失source检查在原入口执行，沿用APP_MANIFEST_INVALID及具体path，合法目录／明确入口保持；facades纯转导出删除，CLI和两项集成测试直连既有工厂，根入口继续导出同样的工厂和配置符号。已核对27项相关回归、正常包严格类型、公开15符号及CLI结果。MC14在baseline、candidate和实际根目录的after全部一致，没有重复代码审查。

Owner用最终正常安装包独立执行同一缺失源反例，退出0、0.079秒，accepted由true变为false，code/path正确；合法目录及显式入口仍成功，失败add没有登记。最终完整patch为`965b6eb65e65790dbb2a2657788f1a1c5deadd6c0e9293e9076d4a88878a1abb`，118个preimage均匹配，选择性采用后after与删除项一致。实际根构建和Host严格类型通过，未重跑无关全量、GUI或人工流程。当前阻断为0。
