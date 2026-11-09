# SRT-02 消费者迁移：r03 实际运行独立复核

2026-11-07。**完整交付 CHANGES_REQUESTED；三文件 Worker／双 Producer 迁移获得限定 APPROVED。** 执行方 70/70，负责人独立新目录重跑也是 70/70。公共消费者在类型检查停止，不能宣称五步完成。

## 已被实际证明的部分

执行方新 `runs/attempt-01` 首命令的 dual 16、Ref 38、scoped 16 项全部通过。负责人核对 36 项输出索引和全部签收输入，在自己的 `owner-review/runs/worker-01` 再次执行同一三文件入口；70/70，19 项输出索引吻合。两次都没有外围超时／强杀，所创建进程组正常退出。

两份实际记录分别证明：三个声明替换保持 View 身份、更换公开 schema 及 activation；四个 R11 用例在授权等待期间变更资格后均零派发、零 handler；D1 两种 Producer 都保留原未授予 Ref 负向；六项 D2 差异为进入 App guard 后拒绝、业务效果为零，未改称框架派发前拒绝。typed 数组确实因对象参数形状不兼容而以 `REF_VALUE_UNSUPPORTED` 拒绝，错业务类型的对照仍存在。

每次运行均有 Ref 39、scoped 17、dual plain 12／SDK Worker 12 条清理记录，记录中的资源均释放；Ref 错误记录为空。这里统计的是记录，RESET 会复用 Worker，不是不同 Worker 数。纯 Core dispose 后字节与 lease 为零；其余低层 Host／Worker 终止不等于公共 Runtime graceful shutdown。本次通过不能追溯补全 r02 缺失的历史清理证据。

[执行方原始结果](../review-evidence/srt-02-consumer-migration-r03-20261107/runs/attempt-01/result.json) · [原件独立审计](../review-evidence/srt-02-consumer-migration-r03-20261107/owner-review/run01-audit.json) · [负责人实际重跑](../review-evidence/srt-02-consumer-migration-r03-20261107/owner-review/runs/worker-01/result.json) · [独立重跑核验](../review-evidence/srt-02-consumer-migration-r03-20261107/owner-review/worker-rerun-audit.json)

## 准出阻断与范围

第二个外层命令 w10 ref-only 已成功完成 Core、SDK 的 TS 5.9.3 严格编译。第三个 adapter 类型入口报两处 TS7016：实际 provider 声明从外部依赖目录导入 `json-schema`，解析到了 JS，未找到类型声明。公共 Worker／Source 脚本尚未生成运行；其后三个 TS 5.3.3 命令未执行。原失败按准入规则保存、停后续命令。

下一修订限于消费者类型环境：复用现成完整 `@types/json-schema@7.0.15`，把 adapter 的类型查找根显式指向新消费者。负责人只读核对本机两版 TypeScript 的 `resolveFromTypeRoot`：TS 5.9.3 的 46558／46573 行与 TS 5.3.3 的 41745／41760 行，均有声明解析失败后的显式 typeRoots 查找。实际是否修复仍需新入口运行证明。

不得关闭 strict 或库检查、加 any shim、删除 adapter 公共导入或类型负向，也不得修改已封存包或共享依赖 store。若仅此依赖与配置变化，七个已通过的 Worker／fixture 源码和 495 件包载荷保持原字节，可以复用 70 项结果；无需再次重跑它们。

## 下一批准出与 Codex Prompt

> 提交新 r04 候选、w10 单处配置差量、完整八文件补丁、全部断言映射，以及新增类型包的真实路径、版本、完整文件指纹和链接。五步改为四步：公共 ref-only（含 TS 5.9.3），再以 TS 5.3.3 编译同次生成的 core、sdk、adapter。先静态交审，不先执行。独立准入后使用新输出目录，失败即停并保留。准出要有公共 SDK／Runtime Worker／Source 实际链路、短收据与 View 正文、原 Ref payload、旧绑定拒绝和正常关闭事实；连同两版严格类型、源和包未漂移一并交回。

正常安装、完整 w10、GUI Host、真实模型、SRT-05 自动观察替换及最终 Semantic 仍不在本批证明中。旧接口退出前，另须同步当前文档及可执行 Core 教程；只读整理的 15 文件／37 行命中是已知义务，不代表完整文档范围，也不授权生产删除。[文档分类](../review-evidence/srt-02-consumer-migration-r03-20261107/owner-review/documentation-next-scope.json)
