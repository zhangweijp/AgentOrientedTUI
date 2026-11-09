# MC-HOST-PREVIEW-01：r02 根目录采用

2026-11-09。**APPROVED_AND_ADOPTED，本项工程交付关闭。** Minimal Core Owner 已对整项 r02 完成独立验收，首轮 R1/R2/R3 全部关闭；SRT Owner 随后核对原始 before、备份六份原件并采用七路径，所有 after 与批准候选一致。

现在有更新通知的已提交页面会刷新停留中的预览，迟到查询不能覆盖较新页面。后台回收 Session 后正常再次激活同一 Topic，聊天与当前预览能够恢复；其他 Topic 消息不会刷新本会话的空闲时间；连接关闭、订阅建立失败及重绑失败沿现有路径处理错误并释放所属监听。在途读取继续由原 Scope 结算与释放，预览不替换 Agent 当前 Observation。

实现沿用 Host、Router、Bridge 与短期 Source 的原职责，删除预览重复 ensureSession，将查询和缓存集中到一个现有入口。没有改 SDK/Runtime/Driver、公共协议、依赖、会话回收政策或业务规则。无通知的提交不另增轮询。

质量证据复用 [r02 完整独立验收](../MINIMAL_CORE/MINIMAL_CORE_HOST_PREVIEW_FINAL_REVIEW_2026-11-09.zh-CN.md)：77 项维护测试与首轮三个原始失败反例均通过，共 80/80、0 跳过；不将重复验证写成 80 种独立业务场景。首轮失败和原实现对照保留，见 [首轮裁决](../MINIMAL_CORE/MINIMAL_CORE_HOST_PREVIEW_REVIEW_2026-11-09.zh-CN.md)。SRT Owner 没有重复行为矩阵。

采用后的实际根目录执行 `pnpm run build` 与 `pnpm run build:gui`，Host main/preload 和 GUI 均退出0，分别耗时1.89秒与2.4秒。[命令与退出码](../review-evidence/host-preview-owner-adoption-20261109/checks.json)及同目录原始日志保留。

批准累计补丁 SHA-256：`c065dbd6d80efa129c781179f1ea871d4148151ff5ec1a702ba0e337df050dbc`。身份、备份与采用事实见 [preflight](../review-evidence/host-preview-owner-adoption-20261109/preflight.json)、[adoption](../review-evidence/host-preview-owner-adoption-20261109/adoption.json)。HEAD 保持 `8938449925ada2f92e072e1c0492af8f2428d14f`，采用期间 index 与 Owner 文件未变，SRT-11 两个已采用路径仍匹配其批准 after。本报告和唯一索引随后由 Owner 更新，未提交、推送、合并或发布。

**边界与下一步。** 本项依据真实目标模块、受控端口和 happy-dom 工程验证关闭；未重新运行真实 Electron IPC、用户 GUI/模型、用户配置/数据库或完整 Worker 信号策略矩阵。历史事故与既有人工签收保持，不把本次采用写成新的人工作流验收。当前无需追加工程修复；下一次正常使用可从根目录 `./run.sh` 启动，在 TUI 预览停留时进行连续两次页面更新，确认真实界面的自动刷新体验。此项体验观察不要求重做整轮 Planning／Ref 验收。
