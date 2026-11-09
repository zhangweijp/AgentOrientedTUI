# Batch 25 GUI 收尾任务

2026-11-06。所有者在 SRT Owner chat 原始回复中明确“已解锁，可以继续”（消息 `01a1af8c-c859-7620-97b0-18683501fa7d`）。Minimal Core 已只读核实。授权继续同批 GUI 门槛，不改变 B25 原交付范围，不采用共享协议，不做真实模型理解实验。

当前整体结论仍是 CHANGES_REQUESTED，直到独立 GUI 复核完成。原执行者清单 `2196fdfa62cc8713e2eee210bb2ae1bd3f1e50575c5bcc1f899bd414889a5253`、首次失败/缓存变化和负责人裁决保持原件。新增证据放 `review-evidence/minimal-core-batch-25/gui-followup/`，以追加记录关闭缺项。

## 所有权与唯一入口

- 执行者只准备 `.tmp/minimal-core-ref-gui-verification-20261106/` 无真实凭据副本、受控 provider 与操作说明，不使用 CUA 或抢占屏幕。Minimal Core 复核静态代码、包身份、路径和网络边界。
- SRT Owner 独占 CUA 可见界面核查，核对实际 Input、Output、View 和关闭流程。执行者不能自行批准自己的 GUI 结果。
- 原 `.tmp/minimal-core-ref-acceptance-20261106/` 的最终 state、Planning 数据、源码及 launch/stop 全部冻结。不得启动、读取私有配置、重置、归档、删除交接标记或将自动检查指向该目录。
- 不停止、不操作原 Host。新 GUI 副本的启动/关闭必须通过独有入口和实际进程身份定位，禁止按 Electron 名称批量结束进程。

## 最小实现范围

复用已封存的 M4.3 Host/Driver/Planning 与精确 B22 SDK、B23 Runtime 包。核心包载荷保持 90/388 件原字节，不重打包；第三方依赖只读复用。所有源码/编译产物内的旧固定绝对路径改为新副本路径并独立重编译。Registry、聊天库、Runtime 数据、Planning 数据、Electron userData/sessionData 与构建缓存全部独立，不修改 HOME。

受控模型只用于 GUI 确定性验证，复用已经验证的 provider 替换边界或同等最小本地脚手架。真实 Host、Driver、Source、Worker 与业务 handler 保持运行；不得代填工具结果、直接替换 View 或以伪造聊天记录充当 GUI 端到端证据。模型的 Ref 名须来自本次实际请求中的页面，不能假定固定下标就算读取正确。外部模型请求为零；无真实 API key，禁止网络请求在离开机器后才处理成失败。

执行者先交清楚的 provider 控制方案与入口，由负责人核对网络边界后交 SRT Owner 操作。已有真实 Source 的 A/B、非法参数与资源释放验证无需机械重跑；本批新证据聚焦先前缺少的实际界面与完整 Host 路径。

## 准出条件与交付

1. 包指纹、全部新路径、静态来源及与冻结交付的差异可核对，冻结环境没有被修改。
2. 新进程启动时实际 userData/sessionData/default session 存储路径均属于新目录；实际窗口与进程身份明确。
3. SRT Owner 实际观察 Planning 页面中的完整 Ref，触发真实工具调用，查看 Input 的完整 Ref、Output 的简短操作收据，以及包含对应对象的当前 View。业务内容不由脚手架伪造。
4. 正常关闭本副本后有资源退出/进程结束证据，原 Host 和冻结手测环境不被停止或修改。
5. 记录 provider 受控性质与零外部模型请求，原 GUI 缺项以新增记录补齐，不改写为此前已通过；本结果不代替真实模型理解、共享集成、发布或最终 Semantic 验收。

Codex Prompt：按以上范围准备新无凭据 GUI 副本，提交路径/包身份、最小 provider 方案、唯一启动/关闭入口及具体操作步骤。你不是唯一工作者，不改别人文件；SRT Owner 独占屏幕，你只负责执行与证据，不自批。待负责人确认网络边界后交独立 GUI 操作，新增记录使用 gui-followup，不重写原清单或最终私有状态。
