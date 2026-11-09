# SRT-15 已验收入口剩余清理：根目录采用

2026-11-09。**APPROVED_AND_ADOPTED，本轮有明确去留依据的剩余清理完成，无待修订阻断。** Clean 整项交付后，Minimal Core Owner 集中独立验收；SRT Owner 核对并备份20个受影响文件，选择性采用16项修改与4项删除。根 Runtime、SDK 构建均通过，分别耗时0.84秒和0.52秒。没有重复跑行为矩阵或人工流程。

删除SDK无人读取的私有挂载计数与只写不读的DOM引用，删除4个只承担内部转导出的Runtime文件，消费者改为引用原源模块；净减191行。Runtime实际View实例身份、挂载／卸载、Ref所有权和Core生命周期保持。三处测试只迁移import，行为断言保留。版本、依赖、公开exports、wire和App写法未改变，没有触碰SRT-14作者指南／示例／skill。

质量证据复用[完整独立验收](../MINIMAL_CORE/MINIMAL_CORE_SRT15_REVIEW_2026-11-09.zh-CN.md)：14文件160/160、0失败／跳过，两项严格公开类型检查通过；独立重建Runtime342件、SDK68件产物与候选一致；六个公开运行时值导出集合不变。声明内部import路径随本次去重调整，不宣称d.ts逐字不变。执行方CLI过滤名修正和复核方清点范围修正的原始记录均保留。

批准patch SHA-256：`afe05b9c94f13b4e76369d840422bc2ab7f14bbee72c5954205021a8e25cf635`。采用后16个after与4项源码删除逐一匹配，四个barrel对应12件JS／map／d.ts在根构建后全部不存在。详见[采用记录](../review-evidence/srt-15-owner-adoption-20261109/adoption.json)、[最终检查](../review-evidence/srt-15-owner-adoption-20261109/checks.json)及同目录20份before备份。HEAD保持`8938449925ada2f92e072e1c0492af8f2428d14f`，index在采用期间保持；未提交、推送、合并或发布。

**本批需要新增人工签收的具体退出项为0。** 删除对象是私有冗余，没有退出用户公开行为或当前支持入口；已有Planning／Ref／View签收继续有效。该结论限于本次实际去留，不扩大为任何历史代码均可删除或全面Legacy退出批准。`ordinary-v2`、`ordinary-params-v1`、当前View数据形状和必要拒绝分支继续承担现存职责。

本批没有重跑正式tar安装矩阵、全仓测试、GUI、真实模型或TS／LSP调查。后续已在执行的完整工作是[SRT-14新上下文Agent作者试用](../MINIMAL_CORE/MINIMAL_CORE_AGENT_AUTHOR_DELIVERY_TASK_2026-11-09.zh-CN.md)，交付后集中验收其公共材料使用、真实行为、修复次数与私有API依赖。不为继续清理而启动未定的字段访问、数据作用域、App元数据或全局错误模型。
