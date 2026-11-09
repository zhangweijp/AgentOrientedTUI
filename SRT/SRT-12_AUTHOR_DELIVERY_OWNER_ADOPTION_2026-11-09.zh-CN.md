# SDK 作者交付：根目录采用

2026-11-09。**APPROVED_AND_ADOPTED。** Minimal Core Owner 已对整项作者交付完成独立集中验收；SRT Owner 按批准的 24 个路径采用到实际根目录，20 份既有文件已备份，4 份新文件此前不存在。采用前 before 和采用后 after 全部一致，没有重做已完成的代码复核或行为矩阵。

当前作者入口统一为静态 Tool 声明、App 级绑定、显式 View 和当前投影；SDK 指南、App Builder skill、文件与 Ref 示例、普通 TypeScript controller 及迁移说明同步。完整工具定义进入 Context Tools，Root 只列工具名；Ref 展示保留类型提示，输入使用 view_id.local_ref。历史阶段教程从当前推荐路线退出，未来字段路径、作用域和基础类型体系仍未实现。

沿用 [完整独立验收](../MINIMAL_CORE/MINIMAL_CORE_AUTHOR_DELIVERY_REVIEW_2026-11-09.zh-CN.md)的质量结论：新正常消费者安装四个 tar，490 份安装文件与 tar 一致；README、完整 App、普通 TS controller、Core 和 Host 原例严格编译及实际运行通过；四个 Runtime 释放成功，普通 TS 的 Scope、lease、逻辑字节和绑定归零。执行方的四包构建、SDK 静态类型及 51 项相关测试单独归档，不重复计数。

本次采用只改变指南、skill、示例和已有验证接线，不修改生产内核、公共 API、协议、依赖或包版本。独立验收采用离线依赖缓存和 ignore-scripts；不代表 registry 发布、原生依赖安装脚本、完整 Driver 严格声明或新模型作者评测通过。SRT-10 已采用诊断作为输入保留。

批准 patch SHA-256：`0ccdc11e6cddc47b54ff18c5341824868b943419591f277b5c310344ba05c531`。采用详情见 [preflight](../review-evidence/author-delivery-owner-adoption-20261109/preflight.json)、[adoption](../review-evidence/author-delivery-owner-adoption-20261109/adoption.json)。HEAD 保持 `8938449925ada2f92e072e1c0492af8f2428d14f`，index 与 Owner 文件在采用期间保持不变；未提交、推送、合并、发布或操作用户 Host／数据库。

**本轮关闭 SRT-12 作者交付，以及 SRT-13／14／15 对应的当前包说明、示例消费与迁移部分；这些专项的未来治理不因此全部完成。** 下一项按原计划推进 SRT-11：Clean 整项完成当前串行链路测量，有真实重复工作且能维持语义时才作最小改进；完整交付后由 Minimal Core Owner 一次独立验收，SRT Owner 负责采用和唯一索引。
