# SRT-04：提交后刷新，交 Clean 实现

2026-11-08。项目所有者最新指令：不要过度防御，不要提前深入实现细节；代码开发交给 Clean。本任务据此转入小范围实现。之前的 API r02 是未封存设计草稿，不是开工门槛，也不规定必须采用其调度钩子或接口。

## 分工

- Clean 负责代码、必要测试和开发交付。
- 本聊天的 SRT Owner 负责范围、节奏、交接和交付复核。
- Minimal Core Owner 提供独立技术复核，并协调其执行方避开同一模块。

你不是唯一在仓库工作的人。不要覆盖或撤销他人修改；用隔离副本实施，保留共享 main 和已签收证据。

## 这次只完成什么

完成串行主链的一个具体行为：App 的操作已经提交页面变化后，下一次观察能取得相容的最新 View、Ref 和工具。实现方式由 Clean 结合实际代码选择，优先复用现有提交、Worker 通信和 Snapshot 接收机制。

- 观察正确性不依赖后台通知恰好先到，也不能靠固定 sleep 或猜测微任务次数。
- 没有变化时可以复用已确认状态；等待限于投影提交，不等待后台业务、重读磁盘或推断业务依赖。
- 业务已成功而页面投影失败时，保留可信业务结果，单独报告观察失败；不重做业务。
- 保留现有来源、关闭、失败反馈和容量保证。新增等待若确有必要，应随现有 owner 结束；用相关测试证明即可，不先设计通用等待/资源系统。

本片保留当前 Scope/Source/Driver 的观察与调用入口，不同时实施 SRT-05 adopt、跨轮 current、raw 历史读取退出或新的全局调度。SDK/Runtime 内部少量接线与必要 SPI 调整可以结合实现处理；若确实需要重大公共消费合同改变，先交具体 diff 和理由，由 Owner 处理，不扩大成整套新 API。

## 基线

隔离技术基线：

    .tmp/typescript-sdk-tooling-20261108/candidate-r01

源清单：

    review-evidence/typescript-sdk-tooling-20261108/source-final.json
    SHA256 15149ff1064d8ab71be93646b15b5a251bbf167fdf672bd7d1fa94142eb5c3d4

以这份源清单建立自己的隔离工作副本并记录差异；不要把共享工作树的脏文件混成基线。需要分支时使用 codex/ 前缀。TypeScript 目标已由所有者确定为统一 7.0.2；SDK 开发工具增量已限定批准。Driver 上游八条严格类型错误和原生 LSP 退出失败是已知独立问题，不在本片重做。

共享仓库 HEAD 为 8938449925ada2f92e072e1c0492af8f2428d14f，但共享代码有大量未提交改动，HEAD 不是本片源码身份。

## 从哪里开始

先看仓库 AGENTS.md、唯一总账 deepseek_review.md 的 SRT-04，以及实际调用链：

- SDK 的 createTUIApp、AppTools 与 projection 提交接线。
- Runtime 的 projection coordinator、Worker flush/push、worker-host、snapshot receiver 和 Scope.observe。

已有只读事实可参考 review-evidence/srt-04-05-readonly-20261108/REPORT.zh-CN.md。API 决策文档用于提示已知问题，不要求逐项实现或重审它们，不重新做整仓盘点。

## 最小验收

1. 用普通 TypeScript 和真实 SDK Worker 分别验证：已提交的更新在下一次观察可见，View/Ref/Tool 相容；关闭通知或未先收到通知也成立。
2. 验证无变化、投影失败不重做业务，以及这次新增等待相关的超时/关闭清理。保留原有有效契约测试和作者测试含义。
3. 运行受影响包构建及相关回归；正式包验证沿用现有机制，第三方已知阻断单列，不降低严格类型检查。没有代码变化的工具链不重复重测。

交付实际隔离路径/源码差异、实现说明、相关测试与未解决问题，状态 READY_FOR_REVIEW。Owner 看实际补丁后独立复核。无需先把每个实现细节写成审批文档。

不推送、合并或发布；本片不启动 Host GUI、真实模型或私人手测状态。
