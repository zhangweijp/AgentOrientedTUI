# SRT-13 当前协议与兼容合同：根目录采用

2026-11-09。**APPROVED_AND_ADOPTED，当前协议事实与支持／拒绝边界收口完成。** Minimal Core Owner 对完整交付集中独立验收后，SRT Owner 核对七路径 before/after、备份原件并采用到实际根目录。根 Runtime → SDK 构建均通过，分别耗时0.57秒和0.42秒，没有重复行为矩阵或人工流程。

生产仅三个Runtime文件五处持久化协议构造值改为引用既有 `STATE_SESSION_PROTOCOL`，三个模块原本已依赖该模块。另三个现有测试补齐错误协议、旧作者标记及合法外壳中的getter拒绝；现有SDK兼容说明补齐九类合同的来源、支持与拒绝边界。API、wire值、版本、依赖、协商方式和App写法不变，没有新增公共协议概念或Core对adapter的依赖。

质量证据复用 [完整独立验收](../MINIMAL_CORE/MINIMAL_CORE_SRT13_REVIEW_2026-11-09.zh-CN.md)：13文件136/136、0跳过；独立重建422件产物与候选一致；44条完整协议输出与改前相同，135对声明相同。执行者的两个正常包严格类型与真实Worker消费证据已由负责人审核，458份安装文件与tar一致，不重复安装或计数。独立复核夹具的初始重放失败和执行者中间失败保留原件，未记为生产问题。

批准patch SHA-256：`06b952091d815e491ca95ca9a2ebacb858fdb870cd8714a6416843b38a191f49`。采用与构建详情见 [adoption](../review-evidence/srt-13-owner-adoption-20261109/adoption.json)、[checks](../review-evidence/srt-13-owner-adoption-20261109/checks.json)。HEAD保持 `8938449925ada2f92e072e1c0492af8f2428d14f`，index在采用期间不变；SRT-11与Host r02已采用路径保持。未提交、推送、合并或发布。

本项没有待修订阻断。当前匹配组合的结论不推广到任意历史／未来版本；正常包消费使用离线缓存和ignore-scripts，未验证registry发布或第三方安装脚本。未来协商、App元数据、全局错误模型、全面Legacy退出及TS/LSP既有问题仍分别保留。

下一项回到原SDK／Runtime清理目标：从已验收Semantic入口核对真实剩余旧实现及职责，按已有签收完成有依据的减法与迁移收口；需要补充验收的具体入口单独说明，不新增笼统人工前置，不开启未定稿架构设计。
