# TS7 原生语言服务诊断：最终独立裁决

2026-11-08。**CHANGES_REQUESTED：原生默认后端的正常关闭门禁未通过，不进入 IDE 生产迁移。** SDK 四文件、正常开发安装、M4 和限定 Jest 的[独立 APPROVED](MINIMAL_CORE_TS7_SDK_TOOLING_REVIEW_2026-11-08.zh-CN.md)保持；正常发布依赖中的 Driver 八条类型错误也仍是独立阻断。

## 已验证事实

本次最终实际入口是 r03，SHA256 `279eb8e81bd911ae775bb0d60bda12bd6667eb79cabb7cd97a54246bd2e3e998`；14 项输入 manifest 为 `8962139ef94a8ba235a36af6e89340db0f6b6b962be36b574989111b4c05c5f9`。它固定 Node 24.15.0、TypeScript 7.0.2、vscode-jsonrpc 8.2.1，Darwin arm64 原生程序 SHA256 `a82f731365ad69d5c4c15f5e18fba4584bf3b7b839960172a76c3462b5114bf2`。

负责人在新消费者 `/private/tmp/aotui-ts7-native-lsp-review-_brde2ki` 正常 npm ci／ls，核对三输入、原生身份并独立预检；随后只执行一次同一准入脚本。负责人实际合成工作目录为 `/private/tmp/aotui-ts7-native-lsp-hl6KQn`，执行方为 `/private/tmp/aotui-ts7-native-lsp-M4zJba`。

| 结果 | 执行方 | 负责人独立运行 |
| --- | --- | --- |
| hover、definition、references、symbols、incoming、outgoing | 通过 | 通过 |
| 编辑前 TS2322、编辑后该错误消失 | 通过 | 通过 |
| 未知方法精确报错后，下一 hover 恢复 | 通过 | 通过 |
| 实际请求数量 | 14 | 14 |
| shutdown | 正确返回 null | 正确返回 null |
| exit | 服务日志 `error handling method 'exit': EOF` | 相同 |
| 子进程终态 | code 1、signal null | code 1、signal null |
| 强制信号 | 无 | 无 |
| 子进程／组 | 均已消失，另有独立组探测 | 均已消失，另有独立组探测 |
| stderr | context canceled | context canceled |
| FSEvents 失败消息 | 10 条 | 10 条 |

双方 28 条完整请求、结果和错误消息，在只替换临时工作目录与 initialize 父 PID 后逐项相同。八项场景有效，正常关闭的第九项失败。没有用 SIGTERM／SIGKILL 制造此次退出，也没有将“进程消失”替换为“健康关闭”。结论限定于固定版本、本机平台和列明协议序列，不推断其他系统或未来版本。

负责人另核对执行方封存的 25 件运行与源码输入。npm 7.0.2 gitHead `2bd066d87f5bafd315be9f40889d0a60b9e58e0b` 对应源码中，handleExit 返回 io.EOF，dispatchLoop 用 lspExit(nil) 取消其上下文，dynamicQueue.Get 返回 ctx.Err()；Server.Run 传出该非 EOF 错误，CLI 打印错误并返回 1，main 用它退出。这条只读推断与双方实测的 context canceled／code 1 一致，尚未实施或验证上游修复。[封存源码与下载来源](../review-evidence/ts7-native-lsp-r03-entry-20261108/execution/source-analysis/facts.json)

三模块未实施方案的三件输入及 18 件既有 IDE 源码身份也已核对。该方案明确原生依赖与开发 API6 分开、当前入口和旧单例消费范围分别盘点，并保留实际 stale／容量／外部依赖更新验证；正常退出阻断解除前仍不准入实施。[未实施方案](../review-evidence/ts7-native-ide-scope-20261108/PROPOSAL.zh-CN.md)

## 三次运行不混算

首次入口的未知方法断言按规范要求 -32601，服务实际返回 -32600；七项通过后中止，恢复和正常关闭未执行，SIGTERM 清理保留。该规范偏差仍在。

r02 精确记录服务实际错误码后，恢复已通过；shutdown 暴露探针显式 undefined 被编码为 `[null]` 的缺陷。负责人独立真实 wire 六项对照确认，生产 client 本来的无实参调用正确。该轮八项通过后强制清理，原失败保留。

r03 只修正两处探针参数转发，原有断言没有降低，最终复现上述服务自行 code 1 退出。三版不计作新增的重复成功场景，不将前两次入口问题归到生产 IDE。首次入口审查遗漏封装缺陷的事实也已在 [r03 准入复核](MINIMAL_CORE_TS7_NATIVE_LSP_ENTRY_REVIEW_R03_2026-11-08.zh-CN.md)记录。

## 未覆盖风险与处理

1. 正常关闭未通过。保持 child code 0、无 signal、真实组消失的原要求，不新增“code 1 也算健康”的例外，不扩大 `processGroupVerified`。
2. 未知方法错误码与规范不符；这与恢复查询可成功是两件事。生产一般 RPC 错误映射保持。
3. FSEvents 失败持续出现。didChange 不能证明未打开依赖的磁盘变更可见；外部监听、文件新增／删除及项目配置更新仍未验。当前不据此推断根因或放宽环境权限。
4. 实际 ScopedLSP 的 root／document／generation、DTO／Unicode、容量与超时、启动取消、根退役和 App 资源关闭尚未在新后端验证。
5. 三模块生产方案可保留为未实施提案；不改共享生产、Host、GUI、真实模型或私人手测状态。SDK／Runtime 不接管语言服务资源。

只读追踪固定源码的 EOF／context／CLI 退出传播可以继续，形成可审查的上游问题材料；任何修复仍须有具体来源及正常安装、真实关闭证据。不得发布派生包、外发 issue／PR 或悄悄回退编译器。所测新 AI SDK 补丁也已在[独立正常消费者](../review-evidence/ts7-upstream-release-recheck-20261108/owner-review/REVIEW.zh-CN.md)复现相同八条严格错误，生产依赖不为此反复更新。

## 下一批具体范围与 Prompt

停止通过修改探针扩大原生后端支持；保存失败与只读归因。整体 Minimal Core 不等待上述两项外部问题才推进，下一批进入 [SRT-04／05 只读语义准备](MINIMAL_CORE_SRT_04_05_READONLY_TASK_2026-11-08.zh-CN.md)：从实际代码定位串行观察刷新、新观察采用、旧资格撤销和框架引用释放的唯一责任位置，提交现状、最小方案、支持边界及可执行验证矩阵。此时不修改生命周期合同或公开 API，不开始新生产实现。

> 封存 r03 首次原生关闭失败和固定源码只读归因；不把 code1 判为正常，不再准备放宽断言的入口，不实施 native IDE 三模块迁移。保留 SDK 独立批准和 Driver 严格类型阻断。随后按 SRT-04／05 只读任务，基于精确候选及当前共享调用链分别给出事实，提出复用现有 owner 的最小刷新／采用／撤销／释放方案。说明对重叠 Context、GUI 诊断预览、失败捕获、在途调用和共享数据的影响；列出真实正负测试和所有者需决定的具体产品/API差异。不要新增管理器、消息 CRUD 或通用资源策略，不写生产、不运行 Host／GUI／模型，不自行签收。

证据：[双方完整消息与关闭事实比对](../review-evidence/ts7-native-lsp-r03-entry-20261108/owner-review/run-comparison.json)；[负责人正常安装与预检](../review-evidence/ts7-native-lsp-r03-entry-20261108/owner-review/independent/preparation.json)；[负责人实际运行命令](../review-evidence/ts7-native-lsp-r03-entry-20261108/owner-review/independent/run-command.json)；[负责人原始结果](../review-evidence/ts7-native-lsp-r03-entry-20261108/owner-review/independent/result.json)；[最终签署](../review-evidence/ts7-native-lsp-r03-entry-20261108/owner-review/final-signoff.json)。
