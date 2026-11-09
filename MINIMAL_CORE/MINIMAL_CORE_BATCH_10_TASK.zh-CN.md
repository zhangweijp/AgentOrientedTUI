# Minimal Core Batch 10 · MCP 更新订阅异常

**负责人派单。** 项目所有者于 2026-11-05 明确要求 Batch 09 保留旧异常行为，登记后单独处理。本文件是这项缺陷的登记与下一批执行指令。Batch 09 准出后启动独立验证。在上级确认异常路径的对外结果前，只在隔离副本制作候选。

## 已经复现的缺陷

MCP 工具成功返回 `ok`。第一个订阅者收到更新，第二个订阅者首次抛出 `subscriber unavailable`。开工版和 Batch 09 初版都执行工具一次，向第一个订阅者通知两次，并把工具结果写成 `Error: subscriber unavailable`。收到这个结果的 Agent 无法从中看出工具已经成功。两个版本的日志和同一输入均已保留。[开工版](review-evidence/minimal-core-batch-09/owner-review/opening-mcp-subscriber.log) · [Batch 09 初版](review-evidence/minimal-core-batch-09/owner-review/initial-mcp-subscriber.log) · [复现用例](review-evidence/minimal-core-batch-09/owner-review/mcp-notify.test.ts.txt)

## 范围与准出

- 以 Batch 09 **最终批准 patch 和实际文件**建立本批基线。候选生产白名单仅 `host/src/mcp/source.ts`，测试白名单仅 `host/test/mcp-driven-source.test.ts`。只有本批执行者可编辑其隔离副本。
- 用现有 MCP Source 和至少一条真实 Driver 调用，把三件事分别记下来：客户端实际执行了几次、模型侧收到哪个工具结果、每个订阅者收到几次更新。使用受控 MCP 边界，记录订阅者先后顺序，禁止真实外部副作用。
- 用相同输入比较成功和工具自身抛错两种情况。加入较早的订阅者抛错、其后的健康订阅者、回调持续抛错。补验已禁用的 Source、server 或 tool 在业务与执行通知两个计数上都为零。复用已有身份与错误映射回归。
- 负责人建议工具结果由真实业务执行决定，通知失败由现有日志记录，每个订阅者最多尝试一次，后续健康订阅者仍可收到更新。请给出该规则与开工行为的逐项差异，供上级确认。只处理工具执行完成后的通知，单列控制开关通知是否会被同一改法影响。
- 交付一份最小候选 diff、首个失败及修复后的真实轨迹、现有受影响测试的结果。沿用现有订阅与日志机制。禁止新增通知管理器、重试队列、全局策略或依赖。生产落地以前须有本批结果语义的确认与独立复核。

## 给 Codex 的 Prompt

> 在 Batch 09 获批后，按这份任务书处理 MCP 工具完成后的订阅异常。先绑定已批准源码，复用现有反例，在隔离副本验证失败的订阅者如何影响工具收据、其他订阅者与 Driver 下一轮。用现有 Source 局部解开工具执行与通知的错误处理，提供可正反重放的最小候选，并写清会改变哪些 Agent 可见结果。将证据和待裁决行为交技术负责人。当前只制作独立候选，保留共享工作树里的 09 交付，不提交、不发布。
