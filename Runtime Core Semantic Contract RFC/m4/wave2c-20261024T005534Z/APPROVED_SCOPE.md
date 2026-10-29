# Wave 2C 授权与边界

依据独立 Wave 2B DESIGN_GATE_PASS 及 CODEX_WAVE2C_DECLARATION_PROMPT.md，仅实现声明保留与旧入口拒绝。

不实现 resolveRef 参数展开、provenance/effectiveArgs 授权、新 invocation/INIT IPC、typed Ref 注册、写入、默认 Router 切换或 Strict。无代理、无依赖安装、无网络。

受影响文件与理由：

- `runtime/src/core/snapshot/types.ts`：记录最小新错误码，不改 Snapshot 字段
- `runtime/src/core/snapshot/validator.ts`：纯 Core Schema 语义验证入口
- `runtime/src/core/snapshot/v2-validator.ts`：V2 复用验证时明确 View-owned 资格
- `runtime/src/core/tool/view-owned-tools.ts`：登记校验及按活态合同拒绝旧 invoke
- `runtime/src/worker-runtime/dom-snapshot-producer.ts`：保留 opt-in/refType 并使用 getter-free JSON 边界
- `runtime/src/worker-runtime/app-kernel/AppKernel.ts`：声明能力、声明 fingerprint、直接/Legacy 注册边界
- `runtime/src/engine/app/worker-host.ts`：授权及派发前拒绝新声明
- `runtime/src/spi/runtime/view-owned-tools.interface.ts`：一个可选声明支持标记
- `sdk/src/operation/types.ts`：唯一批准的新 ParamDef 字段
- `sdk/src/contexts/view-runtime-context.ts`：传递声明能力
- `sdk/src/components/View.tsx`：保留 Runtime port 声明能力
- `sdk/src/hooks/useViewTypeTool.ts`：旧 Runtime/Legacy/mutating 新声明在注册前拒绝

新增一个纯 Core 小模块共享声明语义；新增 Core/SDK/真实 Worker 测试。所有改动相对此次起始工作树计量，不重新计入旧批次。

补充验收意见：SDK receivedArgs 在未来 Ref 展开后可能回显 payload，作为实际执行 Gate 的必验项记录；本批不展开参数，并在 SDK wrapper 前拒绝新声明，因此不提前重构错误返回。
