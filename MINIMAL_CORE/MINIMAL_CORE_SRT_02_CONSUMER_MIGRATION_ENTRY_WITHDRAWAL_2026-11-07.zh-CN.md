# SRT-02 八文件迁移：r01 入口准入撤回

2026-11-07。**CHANGES_REQUESTED。r01 入口准入已在项目行为执行前撤回，当前 NOT_ADMITTED。** 本记录覆盖此前入口复核的准入结论，原评审、签收和静态证据保持原样。

撤回对象为 `preparation-submission.json`（`31ca9073374b765bc1c19a802bb54e73bedf9f718e53c200c5e79a5ad5bedbe9`）对应的 [entry-signoff.json](../review-evidence/srt-02-consumer-migration-20261107/owner-review/entry-signoff.json)（`8d74c0a1bc91480193a520d206e64c3a2bf44af0d5899d79a907d59db3376179`）。该签收刚生成，尚未作为执行指令下发；执行方随后报告静态入口阻断，负责人核对源码确认并立即明确禁止使用。双方均未执行本批项目行为。

## 代码依据与影响

冻结候选的 `runtime/src/engine/app/state-storage-host.ts:17–24` 只读取构造配置 `config.AOTUI_DATA_DIR`；缺失时选择 `homedir()/.aotui/app-state`。`worker-host.ts:330–331` 传入的是 Host 的 `config.config`，不是进程环境。原 `worker-host.ref-v2.test.ts` 和 `worker-host.scoped-interaction-e2e.test.ts` 虽设置 Worker env，却没有给 Host 明确 config。因此此前“相关持久化根已隔离”的入口结论不成立。dual 与 w10 已给明确 config，不受这处缺口影响。

这不是本轮已发生的存储访问：本轮仅做静态检查，且该存储后端按需打开。不能因当前 fixture 未发持久化请求，就把默认路径未覆盖的问题写成已隔离。

scoped 的 afterEach 还在等待 Worker 资源释放之前执行日志断言；断言抛错可能跳过后续清理。应先完成并记录实际收尾，再执行这些断言，不能依赖外围强杀来冒充正常测试清理。

## r02 限定准备与准出

执行方保留 r01 原件，在新的 r02 候选中仅补上述两处 Host config、scoped 清理顺序，以及关联入口和证据；仍限原八文件，不新增生产源码、协议或第九个源码文件。测试断言与行为目标不降低，原始失败与静态历史不覆盖。

重新准入前，负责人须从两个 Host 构造点追踪到 `resolveStateDirectory`，分别核对父侧与 Worker 的实际参数；核对关闭完成后的断言顺序、更新 patch、精确包／源码／运行依赖身份与新输出目录。原 r01 的静态重放及断言映射事实保留，但不自动批准 r02 行为执行。生产删除、共享采用与最终 Semantic 仍未批准。

**Codex Prompt：**

> r01 不执行，保留完整准备包和撤回记录。在新 r02 候选仅修复两处 Host config 和 scoped 收尾顺序，所有原行为断言保持。提交相对 r01 的限定差异、相对签收基线的完整八文件 patch、实际状态根调用链、更新后的入口及指纹，状态 PREPARATION_READY_FOR_REVIEW。未经新的独立入口签收，不执行项目行为，不使用旧 entry-signoff，不改生产代码或包。
