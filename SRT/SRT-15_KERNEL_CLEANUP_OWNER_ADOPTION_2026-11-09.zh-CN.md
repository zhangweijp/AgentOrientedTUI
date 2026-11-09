# SRT-15 内核第二轮减法：采用记录

2026-11-09。状态：**APPROVED_ADOPTED**。本项由MC执行Agent开发、MC Owner唯一复核，SRT Owner直接接收结论并完成采用，没有第二轮代码审查或重复行为矩阵。

批准依据：[MC完整裁决](../MINIMAL_CORE/MINIMAL_CORE_KERNEL_CLEANUP_REVIEW_2026-11-09.zh-CN.md)。采用补丁 `review-evidence/minimal-core-kernel-cleanup-20261109/kernel-cleanup.patch`，SHA-256 `3e56735d3bae609d9911caffb191bd5803a171bcf52baa18b236326fd2e41e3f`。

14个路径的before全部与实际根目录一致，均已保存原件；选择性应用后9个修改文件after一致、5个源码退出。删除的是重复ArrayRef初次登记数组、事件转发包装、没有生产调用者的Desktop Mirror DOM observer及固定规则转换的visitor包装。具体行为分析沿用MC裁决，生产净减311行。

实际根Runtime构建退出0，用时0.794秒；随后SDK构建退出0，用时0.417秒。五个删除源码对应的20个可能dist路径均不存在，不能把这理解为实际删除20个旧文件。依赖未改，没有重新安装。采用前后Git HEAD均为`8938449925ada2f92e072e1c0492af8f2428d14f`，保留共享目录其他变更，未提交、推送、合并或发布。

[采用身份与必要构建记录](../review-evidence/srt15-kernel-cleanup-owner-adoption-20261109/adoption.json)包含14份before备份位置、after核对、产物退出及命令结果。MC独立82项、正常安装包普通／Ref两调用与释放，以及执行方Runtime2089／SDK187等证据直接复用，均以该批准对象为边界。

Clean当前完整合同候选吸收这14路径作为新基线。`runtime/src/facades/index.ts`的额外纯转导出退出涉及Clean已拥有的CLI、根导出与两项集成消费者，已明确并入其当前最终修订，由SRT Owner随新增差异集中验收。这项迁移不包含在本14路径完成事实内。唯一总体状态继续维护于`deepseek_review.md`，不新增人工验收对象。
