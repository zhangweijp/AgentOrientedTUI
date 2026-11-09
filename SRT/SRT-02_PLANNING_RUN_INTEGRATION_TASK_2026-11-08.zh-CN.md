# Planning Ref 接入统一运行入口

2026-11-08。用户从仓库根目录运行 `./run.sh`，实际工具仍要求 plan_id／task_id。Owner 已核对：共享树、SRT-04 r02 和 SRT-05 当前基线中的 Planning 合同与 Root 说明逐字相同，均未纳入已批准的 Planning Ref 应用迁移。这是明确的整合缺口。

## 目标与归属

交付目标是用户从根目录直接运行 `./run.sh` 后，Planning 的页面、说明和实际工具合同一致使用 Ref 选择已有对象。Clean 负责实现与必要验证，Owner 负责统一基线和运行入口采用，Minimal Core Owner 独立复核。

先完成当前 SRT-05 小片并交审，随后立即在其精确候选上建立独立整合副本。SRT-05 未批准前，整合副本可继续开发，但不得作为已验收入口采用。你不是唯一在仓库工作的人，保留共享 main、他人修改和原候选；只提交可审查的实际增量，不整树覆盖或自动 Git 合并。

## 已有输入与最小范围

- 已批准的应用迁移：[独立报告](../MINIMAL_CORE/MINIMAL_CORE_TYPED_REF_AND_PLANNING_REVIEW_2026-11-06.zh-CN.md)。源码在 `.tmp/planning-ref-only-20261106/demo-apps/planning-app`，原 Planning tar SHA256 为 `ac41d296facd7503d5838a57dc0507aee3c1a32e9beba576505143d88e8140c1`。
- 原 Ref patch 在 `.tmp/planning-ref-only-20261106/evidence/planning-app.patch`，SHA256 `93ed70d97fab3e439f36a5236985ff7c5869be7d124f1a8f30657e8866847e1c`。它相对当时的单一声明基线；整合时也须带上 PlanningApp 中已批准的 AppTools／bindings 接线，不能只套该补丁而漏掉前置迁移。
- 根目录 `run.sh` 会重新链接根目录 SDK／Runtime 并构建应用；单独安装一个旧候选包不能稳定改变该启动链。

按 minimalist 复用已批准的 Ref 应用和现有启动机制。范围限于 Planning 迁移及使实际启动链消费一致包所必需的接线；已有 SDK 合同造成的消费者编译问题按真实影响处理，保留原应用功能。业务服务、数据库、用户数据和业务 ID 的内部定位职责保持原归属。

10 个选择已有对象的工具使用 Plan／Phase／Task Ref；create_plan 继续接收创建内容，close_plan 继续关闭唯一活动计划。Runtime 解析 Ref，App 使用对象的内部 ID 并校验存在、归属和业务状态。页面、Root 说明、Schema 与恢复提示一起迁移。

## 验证与采用交接

证明实际启动链解析到配对的 Host／Driver／adapter／SDK／Runtime／Planning，重建后仍是同一合同；检查模型可见的10个对象目标参数不再要求抄写业务 ID，并完成真实 Worker 的创建、打开、修改、关闭及业务守卫检查。沿用已有样例和验证程序，按 SRT-05 的显式采用合同作必要迁移。

先在隔离副本完成构建、相关测试和实际调用，再交根目录入口需要的逐文件增量及当前文件身份，由 Owner 安排审查后采用。根目录入口的合同核验也是本任务的准出条件，不能用另一个 `.tmp` 成功代替。

既有第三方严格声明／LSP 阻断分别记录，不声称已解决；若它们实际阻止这条启动链，交出具体失败与最小影响范围。不要重复无关矩阵，也不要删掉应用、跳过必要构建或使用旧 dist 制造成功。

交付保持轻量：实际差异、所用包与路径、验证结果、根目录采用步骤和剩余问题。用户自行重启后的结果与工程验证分开。未经新的明确指令，不启动用户正在使用的 Host、修改私人手测数据或真实模型配置；不推送、合并或发布。
