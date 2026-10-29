# Wave 2C 限定交付结果

实施范围是“权威声明保留＋旧入口明确拒绝”。本包申请限定验收，不自行签署 ChatGPT 的最终结论。实际 Ref 值解析／派发、provenance 授权、执行 IPC、完整 M4／Strict／默认 Router 切换／可写开放均未准出。

## 1. 已真实实现

新增 `ParamDef.refSource?: 'snapshot-value-v1'` 和唯一可选 port 标记 `refDeclarationSupport?: 'snapshot-value-v1'`。新 SDK 在缺少／未知标记时，注册前拒绝新声明；View-local 明确 readonly 才能声明，Legacy／mutating／default-mutating 拒绝。支持声明的 Runtime 可生成可观察的 V2 Tool metadata。

新纯 Core 模块 `runtime/src/core/tool/ref-declarations.ts`（121 行）复用现有 SnapshotDataError、copyJson 数据边界及类型，不引入依赖、Store、基类、Codec 平台或身份。参数、Registry、Snapshot 与执行端共享该版本化子合同的语义校验。SDK 只做存在性／注册资格检查，由已有 fingerprint port 调用 Core 验证，不静态依赖旧 Runtime 不存在的新值导出。

`x-aotui-ref` version/kind/owner/可选 refType 保留在 inputSchema，参与既有 canonical 聚合、冲突及 binding 失效。getter／非 JSON／错误版本、字段、位置、组合及超预算拒绝；不根据 description、caller JSON 或业务 payload 的同名字符串赋予 Ref 能力。Snapshot V1/V2 exact envelope 字段和版本未改，**新增的是 inputSchema 的语义子合同**。

Host 在授权函数之前拒绝受信任新声明；Worker 通过原 AppKernel → Registry 路径，根据当前注册合同拒绝旧 invocation。剥 annotation 的 descriptor 不匹配 canonical；旧绑定不匹配 bindingVersion。新声明的 optional 参数省略、原始 ID、Markdown 和 caller 对象都不能执行，拒绝路径 Handler=0。

SDK options 与直接 Runtime definition 的 JSON 元数据也在读取前检查自有数据属性，防止外层 params getter 提前运行；保留原严格 JSON 的错误文案。没有冻结业务闭包或修改业务结果 wrapper。

## 2. 实际文件差异与原因

相对**本批起始工作树**，修改 12 个既有生产文件，新增 1 个纯 Core 生产模块与 3 份测试。增量 patch 不包含用户此前已经存在的改动。

| 文件 | 本批作用 |
| --- | --- |
| `runtime/src/core/tool/ref-declarations.ts`（新） | 参数声明投影校验、保留关键字位置／语法／版本、readonly/View-owned 资格；不解析 Ref 值 |
| `runtime/src/core/tool/view-owned-tools.ts` | 登记前验证；invoke 先保留 canonical/binding 检查，再依据当前注册项拒绝新能力 |
| `runtime/src/core/snapshot/types.ts` | 两个最小错误码；不加 Snapshot/Tool/Ref 字段 |
| `runtime/src/core/snapshot/validator.ts` | 复制／预算之后复用纯 Core 语义校验；V1 默认不具 View-owned 声明资格 |
| `runtime/src/core/snapshot/v2-validator.ts` | 内部 V1 proxy 明确传递 V2 View-owned 验证资格；不降级发布 |
| `runtime/src/worker-runtime/dom-snapshot-producer.ts` | 保留 opt-in/refType，新声明先 copyJson；Legacy capture 不接受新声明 |
| `runtime/src/worker-runtime/app-kernel/AppKernel.ts` | 注入一个声明标记、fingerprint 校验、直接／Legacy 注册的数据与资格边界 |
| `runtime/src/engine/app/worker-host.ts` | 只增加 Core import 和授权前拒绝；R1 生命周期、close/release/file I/O 等部分不改 |
| `runtime/src/spi/runtime/view-owned-tools.interface.ts` | 可选声明标记 |
| `sdk/src/operation/types.ts` | 唯一批准的新业务字段 |
| `sdk/src/contexts/view-runtime-context.ts`、`sdk/src/components/View.tsx` | 在既有 port 链传递标记 |
| `sdk/src/hooks/useViewTypeTool.ts` | 注册前旧 Runtime／Legacy／mutating 拒绝，元数据 accessor 防线；原 Handler/SDK 验证结果 wrapper 不改 |

新增测试：`runtime/src/core/tool/ref-declarations.wave2c.test.ts` 39 项，`sdk/src/ref-declarations.wave2c.test.ts` 14 项，`runtime/src/engine/app/worker-host.wave2c-declarations.test.ts` 10 项，共 **63 项新增**。没有修改既有测试、增加 skip/todo 或降低校验约束。

## 3. 真实红绿与兼容修正

| 阶段 | 实测结果／原因 | 日志 |
| --- | --- | --- |
| 初始 Core 反例 | 33 failed /4 passed，37 cases；opt-in/refType 丢失，非法声明未拒绝，旧 invocation 可运行 | `test-red-core.log` |
| 初始 SDK 反例 | 8 failed /3 passed，11 cases；无 marker、Legacy、mutating 和 production 组合未阻断 | `test-red-sdk.log` |
| 初始真实 SDK/Worker | 9 failed /1 passed，10 cases；新声明丢失后，Host/Worker 旧链返回业务成功 | `test-red-worker.log` |
| 最小实现后 | Core 37、SDK 11、真实 Worker 10 均 passed；补充边界后为 38/14/10，最终加 canonical 参数顺序断言成为 39/14/10 | `test-green-*-first.log` |
| 首次生产 tsc | exit 2，TS2345：回调中 properties 的类型收窄未保留；提取 const 后 exit 0 | `test-implementation-runtime-tsc*.log` |
| 第一轮六项全量 | SDK 1 failed /107 passed；新预检错误文案与旧 getter 正确断言不兼容，其余五项 exit 0 | `test-final-wave2c-*.log` |
| 文案兼容修复 | 恢复既有 `Accessors/hidden properties are forbidden`，旧断言原样通过；未改变 getter=0 | `test-sdk-compatibility-message.log` |
| 外层 metadata 追加反例 | SDK 2 failed /12 passed；options.params /definition.params getter 在复制前被读取 | `test-red-outer-metadata-getters.log` |
| 外层 metadata 修复 | descriptor 数据读取替代 accessor；追加测试及旧 View-owned 测试全部通过 | `test-green-outer-metadata-getters.log` |
| canonical 参数顺序反例 | 1 failed /38 passed：调整两个必填参数的键顺序会改变生成的 required 数组；仅对新 opt-in 的派生列表排序，旧投影不改 | `test-red-required-order.log` |

上述失败均保留原始 stdout/stderr 和 exit code，没有覆盖日志，也没有修改旧安全断言掩盖失败。已经完成的中间全量 `final-wave2c-verified-*`、`final-wave2c-sealed-*` 也保留；**最终准出命令集仅为 `final-wave2c-canonical-*`**，是最后一次生产修改之后重新按顺序执行的六项。

## 4. 最终六项全量

| 顺序 | 实际命令 | exit | 实际统计 |
| --- | --- | --- | --- |
| 1 | `pnpm --dir runtime exec tsc --pretty false` | 0 | TypeScript emit 成功 |
| 2 | `pnpm --dir sdk exec tsc --noEmit --pretty false` | 0 | TypeScript 成功 |
| 3 | `pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false` | 0 | TypeScript 成功 |
| 4 | `pnpm --dir runtime exec vitest run --reporter=dot` | 0 | **73 files /697 passed /3 skipped /7 todo**，总 707 cases |
| 5 | `pnpm --dir sdk exec vitest run --reporter=dot` | 0 | **11 files /110 passed** |
| 6 | `pnpm --dir demo-apps/aotui-ide exec jest --runInBand` | 0 | **6 suites /27 passed** |

最后一次代码修改后的三轮专项依次为 **12 files /174 passed，全部 exit 0**。包含本批 Core/真实 SDK+Worker、原 R1 全部 29 项、lifecycle、只读、真实 versioned-file、producer-race、Wave 2A 请求／只读、source-binding 和 Wave 2B Ref 探针。精确 argv 见 `run-stability.py` 和 `commands.jsonl`；每轮独立原始输出见 `test-canonical-stability-1.log` 至 `test-canonical-stability-3.log`。较早三轮的 173 passed 日志也原样保留，重复轮次不是新增独立覆盖量。

原两个独立 R1 脚本原样执行，本次 Runtime tsc 之后重新得到 **0/4 real Worker violations、0/10 controlled violations，均 exit 0**。原脚本、旧日志和独立审查目录未修改；本次输出位于本目录。

TypeScript 生产配置遵循原仓库范围，Runtime 排除 `.test.ts`，其他工程也按其原 tsconfig；不能将生产 tsc 写成所有测试源码已经过 tsc。测试运行耗时仅是命令记录，不是产品 latency/p95。

## 5. 证据层次与剩余限制

| 事项 | 实际证明／限制 |
| --- | --- |
| Core 语义、Schema/Registry 预算、canonical 冲突原子性、失效 | 使用真实 Core/Registry/validator；部分 Draft 是 fixture，不冒充 SDK 挂载 |
| SDK/Preact/实际 AppKernel | 真实挂载、能力传递、生产态检查、直接注册、cleanup、等价 key 顺序；无／未知 marker 是模拟旧 port 合同 |
| SDK/Host/Worker/V2/Handler | 真实 node:worker_threads + SDK，受信任新声明完整保留；Host authorize/dispatch=0；Worker Handler=0；普通 Handler 与业务失败能实际执行 |
| 旧 Host/旧 Runtime 二进制 | **NOT_TESTED**；旧 invocation 形状直达新 Worker 已实测，不冒充完整旧二进制矩阵 |
| Snapshot 值／资源读取 | 没调用 resolveRef 展开，没有 effectiveArgs、provenance、entity I/O、typed Ref 注册 |
| JSON/Scope | 普通 JSON old schema 兼容；metadata getter/隐藏/继承非自有配置不是支持的数据形式。Proxy trap 仍可能执行；不宣称恶意 JS 隔离 |
| 性能与覆盖率 | CPU/heap、p50/p95、coverage 均 **NOT_TESTED**。新增语义遍历有额外成本，未测不能写成零开销 |
| Strict／默认路由／写入 | 未改开关、未切路由、未开放；完整 M4／Strict／Ref 执行继续 **NO-GO** |

用户补充的 `receivedArgs` 风险已纳入 CONTRACT/NEXT：未来 Ref 展开后，框架参数校验错误不能回显展开 payload。本批在 SDK wrapper 前拒绝新声明，没有提前修改业务错误包装或承诺可信 Handler 主动结果不含业务数据。

## 6. 工作树与交付口径

起始基线是 **1257 条路径记录：1235 个实际文件，22 条原本缺失**；包括 Wave 2B 交付后的独立审查材料。读取并备份计划修改的 12 份现有源码，保存原 status、staged/unstaged binary diff、完整 SHA 清单；基线备份为只读。

暂存指纹专指 `SHA-256(git diff --cached --binary)`，**不是 `.git/index` 文件本体哈希**。最终保护结果与具体计数见 `integrity-after-order.json`、原始 `test-protection-after-order.log`、`source-fingerprints.json`：计划外原路径及缺失状态必须无变化；所有旧审计／旧测试保留；HEAD 和暂存差异指纹必须一致。较早的 integrity-final/protection-final 记录也保留，不用旧检查替代最后修改后的检查。忽略规则中的构建产物／缓存不在基线清单，Runtime tsc 按既有规则生成 dist。

`incremental-changes.patch` 基于本批只读源码备份，不以 HEAD 重新计算旧批次，也不包含已有用户改动。`source-fingerprints.json` 区分既有 tracked/untracked、先前 staged/unstaged 和本批新增，给出起始/最终 SHA-256。补丁在 mkdtemp 的基线副本中作只读适用性检查；原仓库不执行 Git 写入操作。

申请：**Wave 2C 声明保留与误用拒绝 LIMITED PASS，等待 ChatGPT 验收**。到此停止，不进入 Ref 执行批次。
