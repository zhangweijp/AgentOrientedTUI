# TS7 原生 LSP 首次运行：独立失败复核

2026-11-08。**完整原生能力与正常关闭准出为 CHANGES_REQUESTED。** 七项已执行场景的证据有效，但错误后恢复和正常关闭没有执行，不能计作九项通过。SDK 四文件的独立批准保持。

## 实际结果与独立核对

执行方按[精确准入](MINIMAL_CORE_TS7_NATIVE_LSP_ENTRY_REVIEW_2026-11-08.zh-CN.md)，在白名单环境只运行一次 `f9ed6f12…` 入口。负责人逐项核对命令、三输入、实际原生二进制、环境和原始 transcript，并保存独立副本。工作目录为 `/private/tmp/aotui-ts7-native-lsp-uPXKw1`，原生进程 PID 70058。

hover、definition、references、symbols、incoming、outgoing、编辑前后的 TS2322 诊断均通过。第八项发送未知方法时，实际返回 `-32600 / InvalidRequest`，原断言要求 `-32601`，因而入口退出 1。原始请求序列只有首次 hover，没有错误后的恢复 hover，也没有 shutdown 请求。

finally 对自己创建的进程组发送 SIGTERM；子进程退出码 1、signal 为 null，stderr 记录 context canceled。负责人另用无信号的进程组存在性检查确认该组已消失。清理完成事实成立，但这是失败后的强制清理，不是正常关闭。

## 错误码判断

JSON-RPC 官方规范将未知方法归为 `-32601`，`-32600` 表示 Request 对象无效。因此原期望有规范依据，不能将首失败改写成单纯的测试错误。[官方错误对象规范](https://www.jsonrpc.org/specification#error_object)

固定原生实现返回的偏差单列保留。现有 `ScopedLSP.query` 将一般 RPC 失败映射为 `LSP_QUERY_FAILED`，不依赖这两个错误码；观察到上游偏差不需要修改应用的公开错误分类，也不需要在 Runtime 增加兼容分支。

后续可提交单独入口修订：精确断言本版本的 `-32600 / InvalidRequest`，显式记录标准期望及实际偏差，再继续恢复 hover 和正常 shutdown。该修订的目的仅为完成剩余能力诊断，不能声称上游已符合未知方法错误码规范，也不能改成“任意异常都通过”。

## 未覆盖风险

transcript 还有七条 FSEvents stream 启动失败消息。当前 didOpen／didChange 正例不能证明磁盘监听健康；未打开依赖文件的磁盘修改、项目文件变化和实际生产根目录更新必须另有证据。不能只凭页面中主动发送文本的场景，就批准真实项目更新行为。

本轮还没有验证正常 shutdown、实际 ScopedLSP 的 root／document／generation 检查、容量、初始化中止和资源所有权。负责人未重复运行已知会失败的原入口；后续独立运行应使用另行批准的精确修订。

## 下一批与 Codex Prompt

> 封存首次原始运行、三输入、强制清理与 FSEvents 事实。只读核对固定原生版本的错误路由，提交一个独立 r02 入口及精确差异；只允许针对未知方法的 -32600 / InvalidRequest 做具名断言并显式记录规范偏差，恢复 hover、正常 shutdown、进程组释放、请求与时间限制保持。此时不运行、不修改生产 IDE、不扩大健康版本范围。负责人核对修订后给出一次有限运行准入；成功仍只证明列明原生协议能力，实际 App 旧结果拒绝和文件更新验收继续单列。

[负责人原始记录副本、独立比对与进程组复核](../review-evidence/typescript-sdk-tooling-20261108/owner-review/native-lsp-run01/review.json)。
