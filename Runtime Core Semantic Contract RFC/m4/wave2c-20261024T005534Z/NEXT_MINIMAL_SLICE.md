# 下一批最小建议 — 尚未授权实施

当前只可观察新声明，实际 Ref 执行仍 NO-GO。本包不批准下一阶段；需 ChatGPT 验收和用户另行授权。

推荐先收敛实际执行的**接口及错误数据范围**，再批准一条最小顶层 snapshot-value 参数链：

1. 明确版本化 invocation／双方能力识别，拒绝未知或旧执行模式。当前 refDeclarationSupport 只能代表声明保留，不能改名或复用成执行授权。是否采用此前提案 VIEW_TOOL_INVOKE_REF_V1、初始化如何表达支持，必须另审 IPC；本批没加这些字段／消息。
2. 定义 Controller 看到的有效 args 与 provenance、授权后的原来源重新 acquire、历史 A 不换最新 B。只从同一固定 Snapshot V2、同一目标 ViewInstance 取自有 snapshot-value object；跨 View/App/entity/数组/嵌套与 typed Ref 注册继续不包含。
3. **先闭合 receivedArgs 错误合同**：给 Ref payload 放入独特的合成测试值，再让另一普通参数触发 SDK 校验失败，证明框架错误不回显 payload；保留 success:false 和安全错误码／参数形状。区分应用主动返回的业务结果，不建通用数据脱敏平台，不无条件改写所有业务结果。
4. 独立批准并测试展开后的 args/provenance 预算，原请求预算不能代替展开预算。32 bindings、合成 envelope、canonical bytes 仍是提案值，本批没有提前实现或验收。

进入代码执行片前，至少审定 SDK/Host 的 opt-in API、授权 scope、IPC 版本与错误公开范围。首个实现片应证明真实 SDK+Worker 的 A 值／policy A／Handler A 一致，Ref-only 更新、Ref 移除、Tool/View 失效、TTL/pin、取消／未知结果及所有拒绝 Handler=0；保留未标注和 Legacy 行为、原 R1、工作树保护及六项回归。

不要将本批 LIMITED PASS 申请写成 Ref 执行 PASS、完整 M4/Strict 或默认 Router/写入开放许可。性能／coverage 和独立旧二进制兼容矩阵仍需单独记录实测，不用命令耗时冒充产品 SLA。
