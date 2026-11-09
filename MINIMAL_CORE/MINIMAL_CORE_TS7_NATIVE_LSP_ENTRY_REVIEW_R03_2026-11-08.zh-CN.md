# TS7 原生 LSP：r02 失败复核与 r03 入口准入

2026-11-08。**r02 正常关闭准出为 CHANGES_REQUESTED；r03 精确有限入口 APPROVED，可以执行一次。** 原两次失败保留，SDK 独立批准不变；生产 IDE 和完整工具链仍未签收。

## r02 失败事实与归因

负责人核对 r02 的精确命令、环境、原始结果与 transcript，并独立确认进程组已消失。八项通过，错误后的 hover 已真实恢复；shutdown 返回 `-32602 / InvalidParams: expected no params, got [null]`。后续正常 exit 没有执行，finally 使用 SIGTERM，子进程 code 1／signal null。该轮有十条 FSEvents 消息，首次为七条，分别记录。

问题出在探针：wrapper 总是调用 `sendRequest(method, params)`，显式 undefined 被实际 vscode-jsonrpc 8.2.1 编码为位置参数 `[null]`。负责人用正常安装的同版本库和真实流编码，独立检查请求／通知各自的 undefined、省略、对象三种输入，共六项通过，未启动子进程。生产 client 原本使用 `sendRequest('shutdown')`／`sendNotification('exit')`，无需修复生产关闭代码。

这个封装缺陷在首次入口审查时漏掉，失败不归咎于生产 IDE，也不通过放宽正常关闭要求消除。负责人未重复运行已知失败的初版或 r02。

## r03 精确差异与准入

负责人核对 r02 execution 的 24 项清单（SHA256 `928ced42bf9a67c625e73ff1db9db8387634a5c2ecad18d642dd78163f476acd`）与 r03 的 14 项清单（`8962139ef94a8ba235a36af6e89340db0f6b6b962be36b574989111b4c05c5f9`）。逐字比较确认只有 request 和 notify 两处 wrapper 在 undefined 时省略第二实参，其他输入处理、断言、时序、资源与失败要求不变。

r03 入口 SHA256 为 `279eb8e81bd911ae775bb0d60bda12bd6667eb79cabb7cd97a54246bd2e3e998`。package、lock 与原生二进制与前版相同。执行方新正常消费者 `/private/tmp/aotui-ts7-native-lsp-r03-prepared-v2fmyuv3` 的三输入已核对；负责人以精确 Node 及白名单环境独立 `--prepare`，退出 0，与封存预检一致，未启动语言服务。

允许按 `owner-review/input-review.json` 的 futureRunCommand／launchEnvironment 执行一次 r03 --run；负责人可在自己的新正常消费者独立复验。仍要求九项通过、错误后恢复、正常 shutdown／exit、child code 0／signal null／group gone、forcedSignals 空数组。原有 24 请求、90 秒工作与有限清理期限、记录预算保持；首失败保存原始输出并停止。

未知方法的 -32600 协议偏差继续保留，不能声称规范符合。FSEvents 与未打开依赖的外部更新、Unicode／DTO、实际 ScopedLSP 的 root／document／generation、容量及初始化清理均未由原生探针验证。通过后才限定生产迁移范围，不自动扩大健康版本。

**下一条 Codex Prompt：** 核对 r03 279eb8e8… 三输入、原生身份与准入白名单环境，执行一次 --run，保留原始命令／退出码／result／transcript／stderr／fixture 及进程组复核。恢复和正常关闭标准不得降低，前两次失败不得覆盖。生产保持不变。成功后提交精确执行清单与三模块、必要依赖及实际生命周期／外部文件更新验证方案，等待负责人独立复验后的具体实施指令。

证据：[r02 独立失败复核](../review-evidence/ts7-native-lsp-r02-entry-20261108/owner-review/run02-failure/review.json)；[六项独立 wire 对照](../review-evidence/ts7-native-lsp-r02-entry-20261108/owner-review/jsonrpc-wire-review.json)；[r03 输入与独立预检](../review-evidence/ts7-native-lsp-r03-entry-20261108/owner-review/input-review.json)；[准入签署](../review-evidence/ts7-native-lsp-r03-entry-20261108/owner-review/admission-signoff.json)。
