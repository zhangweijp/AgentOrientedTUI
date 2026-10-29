# 下一批最小建议 — 需架构负责人另批

推荐先做“声明保留与误用拒绝”，仍不开通 Ref 值派发。技术选择和完整合同见 `REF_CONTRACT_PROPOSAL.md`，本文件不构成实施授权。

1. **Schema / SDK API 批准项**：ParamDef 的 `refSource:'snapshot-value-v1'`；inputSchema property 上封闭的 `x-aotui-ref` V1；只支持目标 View、自有 snapshot-value、顶层单个 Ref ID、object payload。保留可选 refType；unknown 不能满足业务类型。旧 reference 不自动迁移。禁止给 exact ToolDescriptor/V2 根增加未版本化字段。
2. **SPI / 兼容批准项**：Runtime 显式表明能够保留这份声明；旧 Runtime 下 SDK 拒绝启用。新 Runtime 可以投影供观测，Host/Worker 现有调用对新声明 fail closed。对 unannotated 声明的现有执行/聚合/业务结果行为不变，真实 SDK/Worker 证明新声明拒绝时 Handler=0。
3. **该片不改 IPC**：不发送新的可执行请求、不解析 Ref、不添加 provenance 执行参数。当前已验收只读入口的新声明拒绝判断也属于后续实施批准范围，本批没有修改。
4. **下一次独立执行审批**：再审版本化 invocation、双方能力协商、扩展 policy scope、原始请求与有效参数预算及完整双 View/TTL/remount E2E。提议 `VIEW_TOOL_INVOKE_REF_V1` 复用现有执行链；不允许把新字段塞进旧消息后依赖旧 Worker 忽略，不新增 Store/身份/资源读取平台。

验收声明片至少覆盖：reference/string 不再在 opt-in 时语义混淆，refType 在 public canonical 合同中保留，未知版本/组合/预算 fail closed，同类 Schema 冲突可见，旧路径不误执行新声明，六项回归及工作树保护。实际 Ref 解析、业务 typed Ref 元数据注册和性能另立 Gate。

当前没有批准上述改动。等待 ChatGPT 架构验收后，由用户另行授权下一批。
