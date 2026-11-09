# SRT-11：集中验收后的根目录采用

2026-11-09。**APPROVED_AND_ADOPTED，本轮测量与最小清理完成。** Minimal Core Owner 已对完整交付一次独立验收；SRT Owner 核对两个目标的 before/after、备份原件并采用到实际根目录，Runtime 构建通过。

生产改动仅删除授权返回后紧邻的第二次 `recheck()`；两次检查之间只有严格布尔判断，保留的一次仍在授权结算后完整复核观察资格、Ref、binding 与 live 状态。没有删除跨 await 的检查，也没有新增缓存、抽象、协议、依赖、资源策略或应用职责。另一文件新增普通/Ref 两种模式下共八项授权边界行为测试。

**质量与收益按实际证据记载：** 独立验收在精确候选运行三个相关文件，236/236 通过、0 跳过；并从原始 inspector 记录重算两版各20阶段，12组调用比较确认少一轮参数准备、一次profile编译及11次copyJson。Worker与无变化观察的计数不变。独立负责人没有重跑整套计时采样，执行方计时改善有限、部分p95上浮，不据此承诺Runtime普遍提速。

完整判断与边界见 [独立验收](../MINIMAL_CORE/MINIMAL_CORE_SRT11_REVIEW_2026-11-09.zh-CN.md)，原始计时和失败记录见 [执行报告](../review-evidence/srt-11-measure-reuse-20261109/REPORT.zh-CN.md)。SRT Owner 沿用这次验收，没有追加第二轮行为矩阵；采用后的根Runtime构建退出0，耗时0.5秒，见 [构建结果](../review-evidence/srt-11-owner-adoption-20261109/root-runtime-build.json)。

批准补丁 SHA-256 为 `9bf57b6d67e278ba59f1c592f188907d1488a74b8d21803e7ec031914c12e3fd`。两文件实际采用及备份见 [adoption.json](../review-evidence/srt-11-owner-adoption-20261109/adoption.json)。HEAD 保持 `8938449925ada2f92e072e1c0492af8f2428d14f`，采用期间 index 与 Owner 文件未变；本记录及 deepseek 索引随后由 Owner 更新。未提交、推送、合并、发布或操作用户Host／数据库。

**本批无剩余阻断，不启动第二轮性能改造。** 下一条执行指令沿用正在进行的 MC-HOST-PREVIEW-01 完整任务：指定执行agent完成Host预览复现、必要修复和验证后，由Minimal Core Owner一次集中验收，再按实际交付协调采用。未来缓存／dirty合同、并发、RSS、真实模型性能和既有TS/LSP专项不因本批完成而关闭。
