# Wave 2A 范围与待证事实

- runtime/src/engine/app/worker-host.ts：完整请求先严格复制，原 args depth/node/bytes 预算不放宽；来源复核只读稳定选择器；字面 true 授权；来源/策略/dispatch 异常不读取任意 message；scope 冻结。先写失败用例，再做本入口最小改动。
- 新增 worker-host.wave2a-request.test.ts：真实 Core Store + Host 的请求、预算、异步修改、TTL 与异常边界。模拟 IPC 的结果不作为真实 Handler 身份证明。
- 新增 source-binding.wave2a.test.ts：现有 Core 时钟/lease/历史保留规则的显式合同补证，不预设需要改 Core。
- 新增 worker-host.wave2a-readonly.test.ts：实际 SDK/Worker、双 FileDetail 同名 Tool、授权等待变化、注册/Schema/重挂载、错误结果、Handler 计数、关闭/RESET 与不支持的通用 Ref 自动解析边界。

当前静态差异不是全部已证明的业务越权。报告须区分复现的授权/输入/来源检查失败与尚未证明的业务利用。Core/Registry/SDK 已有正确机制优先补证；不新造执行器、身份、Codec 或 Snapshot 存储。不改默认路由、可写入口、Strict、上批交付或独立审计。
