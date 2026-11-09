# Host 验收反馈：集中复核与采用结论

2026-11-09，SRT Owner。**APPROVED_ADOPTED。** Clean 完成[整项任务](HOST_ACCEPTANCE_FOLLOWUP_CLEAN_TASK_2026-11-09.zh-CN.md)，Owner 已集中复核 5 个路径、原始调用时间线及修复前后正常包证据，并选择性采用到实际根目录。无实现或采用阻断，不追加 MC Owner 审查或全套人工验收。

结论分别为：**A2／A4 本地未复现，NO_CHANGE；A3 三条错误提示已修复并采用。** 没有将原始异常未被证明的原因写成“已修复”。[用户回传报告](../review-evidence/host-deepseek-acceptance-20261109-221114/USER_REPORT.zh-CN.md)和此前通过的使用流程保留。用户先报告最终界面“尚未检查”，随后按[短Prompt](HOST_FINAL_UI_CONFIRMATION_PROMPT_2026-11-09.zh-CN.md)完成检查并回传[补充报告](../review-evidence/host-deepseek-acceptance-20261109-221114/USER_FINAL_UI_CONFIRMATION.zh-CN.md)：FileDetail退出、IDE关闭、Planning打开／关闭正常，三项均确认“全部正常”。**最终关闭界面人工确认通过，本轮待补项已关闭。** 暂停／恢复按用户决定未执行。

## A2／A4：已核实与无法证明的边界

Clean 只读定位本轮验收 topic 的 128 条已保存消息；原件包含工具调用 ID、输入和收据，缺少逐轮注入的完整 View／GUI 快照。Owner 直接核对已提取记录，没有再次访问运行中的 Host。

- A2：fd_4 的关闭收据为 22:31:59.372，fd_5 为 22:32:00.851，均 closed:1；中间 Workspace 是否确实显示 No files open，没有原始 View 佐证。正常包的开A→开B→关A→重开A→关B→关新A流程中，每次操作后立即采用观察，Workspace、FileDetail 与工具集合一致。关B后新A仍存在，关闭新A成功是正确行为；旧A的 view_id 被拒绝为 IDE_FILE_VIEW_CLOSED。
- A4：B此前已有“已改”标题，最后 open_plan 收据为22:32:11.299，追加“复验”的 update_task 收据为22:32:13.745。最终标题在保存消息中首次出现于该次 update_task 输入。新建唯一名称计划的验证中，更新前没有未来标题，更新后及重新打开时显示新标题，A保持不变。
- 上述证据支持当前路径未复现问题，不能证明当时模型所见页面一定正确，也不能认定模型回述或预览时序混淆就是原始原因。保留这一限制即可，不为推测更改关闭、投影或业务语义。
- 原报告7.4简写的Planning输入已经由原记录确认包含 `plan_list.`／`plan_detail.`；不存在需要新增裸局部名兼容的证据。

依据：[原始调用时间线](../.tmp/host-acceptance-followup-20261109/evidence/original-call-timeline.json)、[两版对照](../.tmp/host-acceptance-followup-20261109/evidence/comparison.json)。这些结论不要求用户重新跑全套；若自然使用时再次出现，新增的当轮页面与相邻调用记录可用于继续定位。

## A3：已采用的最小修复

| code | 现在提供的解释与恢复动作 |
| --- | --- |
| REF_TYPE_MISMATCH | 指明出错参数、期望 Ref 类型与实际类型，并提示从最新 View 使用正确的 view_id.ref_id |
| IDE_FILE_NOT_LOADED | 说明文件没有打开，提示用 multi_open_file 以绝对路径打开、阅读 FileDetail 后操作 |
| RESOURCE_CONFLICT | 说明磁盘文件与已加载版本不同，提示用 multi_open_file 重载、检查最新内容后重新应用修改 |

Core 只透传本地构造的 REF_TYPE_MISMATCH 说明；参数名与类型名各截取64码元并JSON转义，不附payload／业务ID。IDEError 对两个已知 code 提供固定提示，现有 fail 保留其 message。其余 code 仍使用原提示，effects／partial／unknown、授权、Ref解析、参数检查、拒绝阶段和资源责任保持；没有自动重试或新增诊断框架。

Owner已核对输入合同保证Ref类型为字符串、两处拒绝传播使用同一限定说明，以及既有Core测试仍验证handler不进入与清理，同时新增外层message断言。变更为4生产路径＋1既有测试，生产16行增加／8行删除，无新增文件、依赖或协议版本。

## 采用身份与质量证据

批准 patch SHA-256：`0ded5c68f45bc69feb053b62acf119fe70c89d988a9447290ba568d9dabf98a1`，来自[完整交付](../.tmp/host-acceptance-followup-20261109/REPORT.zh-CN.md)。Owner核对全部5项实际before、冻结before／after与候选一致，patch路径集合相同，apply检查通过；备份before后采用，构建后全部after仍匹配。HEAD前后均为 `8938449925ada2f92e072e1c0492af8f2428d14f`，IDE生成元数据未产生额外变化。

复用并核对Clean有效证据：Core／Ref 4文件383项、IDE 6文件63项；Runtime／SDK／IDE／Planning构建；前后各602件正常六包安装载荷；同一字节探针前后各23调用、21采用观察。Owner直接比较原始facts中的工具名、status与code序列，全部一致，三条错误提示改变，拒绝后恢复和两版最终释放报告通过。没有再次运行这些行为矩阵。

实际根目录必要验证由Owner执行：Runtime构建exit 0、0.794秒；IDE构建exit 0、1.093秒。原件见[Owner复核记录](../review-evidence/host-acceptance-followup-owner-20261109/review.json)、[采用记录](../review-evidence/host-acceptance-followup-owner-20261109/adoption.json)、[根构建](../review-evidence/host-acceptance-followup-owner-20261109/root-validation.json)。

两份改变的本地tar身份已核对：Runtime `ef981bcd88ed8c92d2470264f61aad79ddd5b081b030e9e57b47a47d5e5a5cca`，IDE `09154c2dcd834902f4bc2255a427bfd221659cc369f8aebd0358e8bbc059831d`。其余包沿用交付中相同的前后归档；不以版本号相同替代哈希。探针首次输出文件命名覆盖及辅助Node23／CommonJS解析失败按执行报告保留，不将它们冒充产品回归或有效原件。

## 当前状态与下一步

本反馈任务的核实、限定修复、负责人复核与实际采用已经完成；A2／A4保留未证实的历史观察，不是新增开发阻断。下次正常通过 `./run.sh` 重启Host后使用新的错误提示。最终关闭界面已获用户明确确认，本轮约定范围人工验收也已收口，无需新增开发、复核或人工确认。暂停／恢复及本次未覆盖项仍按原范围记载，正常使用即可；测试数据按用户报告继续保留。

本轮没有操作用户验收文件／计划或重启运行中的Host，没有提交、推送、合并或发布。不新增观察凭据接口、多PlanDetail业务能力、平台资格或通用错误治理。
