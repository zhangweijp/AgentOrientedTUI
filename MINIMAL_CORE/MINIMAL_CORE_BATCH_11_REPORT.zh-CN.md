# Minimal Core Batch 11 · R4 普通参数校验只读盘点

**READY_FOR_REVIEW。本批未实施 R4，共享生产、永久测试和公开 API 修改均为零。** 当前没有找到可以不先迁移责任、直接等价删除的参数检查。已在独立副本取得公开 Core、真实 Worker 和两种删除实验的可复跑记录。

## 1. 基线与实际运行身份

取样主树 HEAD 为 `8938449925ada2f92e072e1c0492af8f2428d14f`，使用当时实际源码，未检出 HEAD 替代脏工作树。独立目录为 `/private/tmp/aotui-minimal-core-batch-11-eokaehjn`；`review-evidence/minimal-core-batch-11/baseline.json` 记录 301 份源码/测试/配置、实际指纹与 SRT 两棵树的只读快照。关键原件在 `inputs/`。

Runtime、SDK 均在副本重新构建；SDK 的私有依赖链接指向同一副本 Runtime。公开 Core 探针只调用编译出的 `dist/core/index.js` 公共导出；真实 Worker 使用副本新建 Host/worker-runtime、实际 SDK dist 和受控 App。实际加载路径、444 份构建文件指纹及完整命令分别保存在 `baseline-build-inputs.json`、`commands.json` 和原始日志中，没有使用共享旧 dist 冒充本次产物。

Batch 10 已由所有者授权、负责人应用到共享 Host，两处新字节在本批开工基线中按已授权批外落地登记；依据为 `owner-review/shared-application/final-application.json`，并非 Batch 11 修改。

## 2. 参数实际经过哪里

| 阶段与位置 | 所有者、使用值与当前职责 | 判断 |
| --- | --- | --- |
| Core `ScopeClient.invoke` | 首次有界捕获完整请求，校验壳形状并形成调用指纹；随后 ordinary 路径按独立预算再捕获 rawInput，起初 effectiveInput 与它相同 | 请求预算、普通输入预算及 ledger 责任不同，不能合并为一次无边界读取 |
| Core `run` → binding.validateInput | Host binding 用公开 profile 的合同校验；独立 Core binding 也可显式转换。Core 捕获 validator 返回壳和值，形成冻结 effectiveInput | 必须保留。它发生在授权前，既不是 SDK 的隐式 coercion，也不是可省略的展示检查 |
| `policy.authorize(context)` → binding.execute | 同一冻结 Context/effectiveInput；await validator、await authorize 后重新核对来源、binding 和 liveness | 必须保留异步后复查，授权不能让旧来源重新有效 |
| Host `resolveInteractionSource` / `sendRequest` | 从已观察 profile 编译授权所需参数合同；执行发送 effectiveInput。发送边界另捕获完整 IPC envelope 和特定 args 预算 | 授权前理解输入与 IPC 有界捕获各有职责。跨线程只保证值对应，不保证 JS 对象身份相同 |
| Worker `captureOrdinaryV2Request` | 独立捕获收到的数据，核对精确壳、类型/模式/身份对应、args 对象及预算 | 不信任 Host 已做过检查；必须保留 |
| Worker `invokeOrdinaryInvocationV2` | 协商、App instance、binding 校验后，从 wire profile 编译并验证 args，再调用 Kernel/Registry | 目前仍是真实运行边界。不能只因默认 SDK 也校验而删除 |
| Registry `invokeTypeTool` | 最终复查 activation/注册/合同身份，再进入保存的 invoke。**当前不在这里执行参数合同** | 身份检查不是参数检查；不能把目标方案当成当前实现 |
| SDK `invokeOrdinaryParameterTool` | 使用注册工厂拿到的 Runtime 编译合同验证并复制/冻结参数，随后进入 handler；还负责 handler 异常和 effects 提取，同时服务 Ref 路径 | 当前不可整段删除。要先迁移普通参数最终校验，保留结果/Ref 职责 |

注册时 `registerTypeTool` 已编译一份 contract，但只交给 factory；registration 保存的是 invoke 和公开 definition，没有独立执行最终参数校验所需的 contract 字段。故“Registry 已经兜住参数，SDK/Worker 检查皆可删”这一前提不成立。

## 3. 公开 Core：三个代表输入与复查

`core-probe.mjs` 经真实公共 Core、ScopeClient、Snapshot/Registry 和受控 handler 运行。完整输入、返回、顺序、计数及引用比较在 `baseline-core-trace.json`。

- 合法 `{line:7}`：validator/authorize/execute/handler 各 1；`defaulted` 虽有 default 注释也没有隐式加入。
- 非法 `{line:'wrong'}`：`ACTION_INPUT_INVALID`，authorize/execute/handler 均 0。
- 可信显式转换：原始 `{line:'7',surplus:true}` 变为 `{line:7,defaulted:true}`；raw 保留原值。授权与执行使用**同一个 Context、同一个冻结 effectiveInput**，本例纯 Core handler 也直接收到该对象。validator 返回的外部对象另被捕获隔离。
- validator 或 authorize 在异步结算前使来源失效：均拒绝，handler 0。Scope/lease 清理为 0；Store 按既有历史保留规则仍可保留快照，没有通过改 TTL 制造“全部归零”。

**删除实验一：**仅在副本删除 `initial.validateInput` 及其返回值处理块，保留请求捕获、context 组装和授权后复查，再重建。非法输入由 handler 0 变 1；转换丢失，授权/执行看到原始字符串及 surplus；validator 触发的失效也不再发生。授权后的独立失效复查仍会阻止进入，说明反例不是把所有门禁一起关掉。完整反事实输出在 `without-core-validator-core-trace.json`，实验 diff 明确标为 `EXPERIMENT_ONLY`，不是建议落地 patch。

## 4. 真实 Worker 与第二处“重复检查”反例

复用现有 `worker-host.ordinary-v2.test.ts`，运行 8 个定向用例：正常、非法 enum/extra、四类异步授权失效、直接坏 wire。原始 `real-worker-facts.json` 包含实际发送 envelope、授权参数、Worker handler 事件及完整响应。

正常路径 authorize/post/handler 各 1，值相等、handler 参数冻结，SDK 不加 default。非法 enum/extra 在授权前拒绝，发送和 handler 0。异步授权后 disable/rebind/unmount/close 都不进入业务。直接绕过 Host 正常入口，把 `e:1` 发给真实 Worker，收到 not-entered/E_INVALID_ARGS，handler 0。

**删除实验二：**只在副本删除 Worker 的 `validOrdinaryV2Arguments` 分支，Core 恢复原实现：

1. 真实 SDK Worker 仍拒绝同一个坏输入，但完整错误从 `Expected valid ordinary-v2 Tool parameters` 变为 `Tool arguments do not match the committed contract`，并新增 diagnostics。只比较 code/phase 会漏掉这项公开结果差异。
2. 现有合法注册 factory 若直接返回 invoker、未另加 SDK 校验，enum/extra/null 三例从未进入变为 entered-returned，三项原保护用例失败。当前 Registry 并没有接管这一责任，不能靠 App factory 自觉补上。

两次 Worker envelope 的 instance/snapshot 身份自然不同，完整原件均保留；这里只比较完整 terminal/result 及同样参数，不通过归一化整个 wire 制造相等。实验后恢复原字节并重建，原边界两文件 **128 passed**，SDK helper **9 passed**。

## 5. 与 SRT-01 的关系

只读取样 `.tmp/worktrees/srt-01-m4-20261105` 与 `srt-01-m3-repair-01-20261105`，两者捕获时 HEAD 均为 `dde087dad13f176a273ddd5f1c3d9a212273bbdc`；工作树字节另外逐文件保存，不能用相同 HEAD 代替实际文件身份。本批没有运行 SRT 套件，也不声称其整批验收状态。

`srt-comparison.json` 显示，两树的 Core validator 处理块、ordinary 请求捕获/args 检查、Worker 调用函数、Registry invokeTypeTool、profile 编译函数，与主树对应片段一致；整文件因历史收敛不同而不全部相同。SDK 入口则已从主树旧 hook 转为 `sdk/src/tools/view-type-tool.ts` 控制器，helper 新增了 **validate 后的 canEnter**，控制器在该处重新选择当前可用 callable。这项后置资格检查不能随参数去重一起丢掉。

因此当前两个反例对这些已对照片段仍有参考意义，但运行证据只来自主树独立副本。未来 R4 必须在最终选定的 SRT 组合版本重新绑定身份并验证，不能整文件覆盖、恢复旧 hook，或让 App 再迁一次。本次结束时取样的 SRT 文件无指纹漂移。

## 6. 可删判断与下一步

**本轮不建议派发任何“直接删除检查”的生产任务。**

- Core 授权前可信 validator、返回捕获、异步后 liveness、IPC 捕获/预算/协商/实例及最终注册资格继续保留。
- Worker 每次从 profile 编译参数、SDK 普通参数重验确有潜在重复成本，但当前缺少 Runtime 最终合同 owner；必须先完成注册表持有并执行 compiled contract 的责任迁移，保存错误完整字段及优先级、factory/Ref 分支和 SRT canEnter，再判断能删哪段。
- 与参数无关的紧邻 binding 检查也不能在本批顺手删。现有回归明确刻画了校验后、实际 invoker 进入时重绑定仍须拒绝；新的唯一入口必须承接这些保证。

本报告不授权上述迁移，不修改 Ref、配额、结果协议或 SDK API。D3 已取消。可以按只读盘点结项，将具体 R4 实施白名单留给负责人在责任迁移方案明确后下发。

## 7. 证据与执行边界

证据索引为 `review-evidence/minimal-core-batch-11/README.zh-CN.md`，封版清单为同目录 `final-delivery.json`。所有命令、cwd、退出码、输入 SHA 和 stdout/stderr 保留。Worker 8 项为名称过滤取样，另 22 项未选；删除实验的 1 项亦为取样，不将未选项计为通过，没有添加 skip。

Core 探针初稿误把 whenClosed 当作 ScopeClient 方法（实际在 authority），以及用普通原型字面量严格比较捕获出的 null 原型对象；两个非零日志和原稿保留。修正探针后五例完整运行通过，未修改生产来迁就探针。删除 Worker 保护后 3 项失败是有意反例，不是基线回归。最后 audit 的空格警告也保留并修正，未涉及生产。

实验结束，副本源码/测试/配置全部恢复为开工字节，444 份构建产物也与基线逐字节相同。共享 301 份输入、保护项、HEAD/index 保持。未跑完整 Runtime/SDK/Host/Driver、SRT、GUI、实网或性能验收；没有提交、push、merge、发布或 R4 生产落地。
