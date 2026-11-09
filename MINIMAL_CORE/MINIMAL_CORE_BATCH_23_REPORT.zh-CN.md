# Batch 23 交付报告：按工具声明使用路径、JSON 与完整 Ref 名

**READY_FOR_REVIEW。** 本轮完成隔离候选与必要验证，等待负责人独立复核。共享 `runtime/src/adapters/system-instruction.ts` 尚未修改；批准后才应用精确差异并单独复验。B22 仍是隔离候选，没有将其协议带入共享树，也没有提交、push、merge、发布或宣布 Semantic 验收。

## 1. 改了什么

唯一生产差异在 `runtime/src/adapters/system-instruction.ts` 的默认说明文本：

- 把错误的 `(content)[type:ref_id]` 改成实际 SDK 的 `[content](complete_ref_name)`。
- 示例调用复制完整名字，如 `Todo:pending[0]`，保留已有前缀、大小写和下标。
- 删除“object 都传 Ref”和“Ref 替代所有普通 ID”的全局规则；文件路径、普通 JSON、显式 Ref 各按工具声明传参。
- 明确文件直接传路径，不额外注册/包装 Ref；普通 Markdown 链接不自动成为可用 Ref。
- 说明引用并不把全部数据自动放进模型上下文，也不绕过应用权限、版本或业务前置条件。
- 同步修正文件后半部分的参数提示及 Critical Reminders，避免保留相反规则。原应用操作、动态工具、View 生命周期说明保留。

没有修改 loader 的行为、参数合同、SDK API、名字规则、协议、预算、观察或释放；没有增加解析器、默认转换、状态或依赖。实际包中只有该说明的 JS、source map 和声明常量文字变化。

## 2. 基线、范围与指纹

已完整读取 AGENTS、minimalist、[B23 任务](MINIMAL_CORE_BATCH_23_TASK.zh-CN.md)、[B22 签收](MINIMAL_CORE_BATCH_22_REVIEW.zh-CN.md)及 [SRT 分工](MINIMAL_CORE_SRT_BOUNDARY_2026-11-06.zh-CN.md)。Task SHA 为 `2a0c5fae3da2922b844981b9ef98bf0d9482f65ca017beb70b5fc9dae6b9622f`。SRT-01/G3 作者评测及其他 App 迁移没有重做。

开工保存实际共享树 **12,189 个路径**、Git 状态/HEAD/index及目标 preimage；历史证据中的 dist 也纳入保护。共享文件、B22 重建文件和 preimage 的 SHA 均为 `1a491f3509ad6aae8bba62a5b4cee659af59e67440915794ec5f98ab82c92c36`。没有用 HEAD 覆盖实际基线。[基线](../review-evidence/minimal-core-batch-23/baseline.json) · [工作树指纹](../review-evidence/minimal-core-batch-23/workspace-before.json)

隔离实现目录为 `/private/tmp/aotui-b23-at3o_gty`，最终干净复跑目录为 `/private/tmp/aotui-b23-replay-m3_p24a6`。源码从 B22 的固定 Git＋三份历史补丁＋已批准 B22 patch 重建，基线 Runtime 重新打包精确匹配 B22；没有借用旧临时源码目录。

| 对象 | SHA-256 |
| --- | --- |
| [单文件 patch](MINIMAL_CORE_BATCH_23.patch) | `112e2a594ee119e23f15428b85e46445ffe9f9c654a4e60aa08f7dd5e7dac80c` |
| 候选说明源码 | `5aa85eab652e8867d372f6e2d5c68430dd57d099c7d2eacfaa0f061eab7de778` |
| 未改的 B22 SDK tar | `c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff` |
| B22 基线 Runtime tar | `0f0896237ec113c65fcd91b4e3697229fd7b647a811eae10f8b4dbb2f4f7573b` |
| [B23 候选 Runtime tar](../review-evidence/minimal-core-batch-23/runs/01/artifacts/aotui-runtime-3.0.0.tgz) | `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6` |

[源码前后原件](../review-evidence/minimal-core-batch-23/candidate-source/runtime/src/adapters/system-instruction.ts)及 [preimage](../review-evidence/minimal-core-batch-23/preimage/runtime/src/adapters/system-instruction.ts) 保留。正向检查/重放、反向检查/恢复和 `--whitespace=error-all` 均通过，最终源码只差这一文件。

## 3. 验证的是哪条真实链路

两侧均实际安装 SDK/Runtime tar，逐包逐文件核对，未使用源码 symlink 冒充包消费。Runtime 是已签收 B22 隔离组合，SDK 不变。当前已存在的 Driver 构建按原字节封存，依赖解析和版本另存；没有修改或重建共享 Driver。

链路为：实际 SDK App → 实际 Node Worker → 默认 `SemanticAOTUIDrivenSource.getContext` → 当前 Driver 的真实运行主链 → `LLMClient.call` → 真实 `streamText` → 受控 provider。只替换 provider 创建边界，执行和 Context 包装仅被动记录并调用原方法，没有伪造 Source、接收器、LLMClient 响应或业务结果。调用一次真实 run 的方式复用既有 execution-owner 试件。

**受控 provider 不是实际 LLM 理解评测。** 它固定返回正确合同的调用，基线与候选均应执行业务成功。原说明与页面格式不一致由实际 getContext 对照证明，没有把试件错误、旧说明下的确定性成功或构建失败包装成模型理解的红绿。外部模型调用为 **0**。

模型调用边界完整保留 messages/tools。实际说明作为 Source 的 User Message 进入 provider prompt；候选 prompt 包含完整新说明，而实际页面含 `[Inspect existing Ref parameters](Plan:plans[0])` 和 Available references。工具 Schema 分别为路径 string、普通 options object、显式 Plan Ref 的模型 string，类型与正文没有被通用 Ref 规则覆盖。[基线完整链路](../review-evidence/minimal-core-batch-23/runs/01/evidence/baseline-parameters.json) · [候选完整链路](../review-evidence/minimal-core-batch-23/runs/01/evidence/candidate-parameters.json)

## 4. 具体结果

每侧受控模型 **1 次**请求、Driver 串行 **3 次**执行，业务各一次：

| 参数 | 业务实收及结果 |
| --- | --- |
| 文件路径 | 含空格的临时绝对路径原样进入；refSources 为空。App 限定唯一可读临时文件并检查内容版本，返回 path/version/bytes 收据；正文只在 File View 中，结果没有重复正文。 |
| 普通 JSON | options 保持普通对象，包括嵌套数据，授权及业务得到相同 JSON；refSources 为空。使用现有基础 object 字段合同，不新增或宣称 Runtime 已校验任意嵌套业务 Schema。 |
| 显式 Ref | 原始参数为完整 `Plan:plans[0]`；Core 从获准观察解析，授权、wire 与业务保留对应完整 Plan 和独立 Ref 来源，返回 `plan_a` 收据。 |

四个错误 Ref 输入：省略前缀、猜名、把普通文档 URL 当 Ref、直接上传对象，全部在 Core 派发前拒绝，业务及业务请求均为 **0**。文件错误路径与旧版本是另外两项 **App 自己返回的失败**，没有冒称为 Core 拒绝或 handler 未进入，也没有把业务职责搬入 Runtime。

Driver 捕获一次 Context，三个 call/result 按 ID 配对，结果发布后释放一次；模型 SDK 没有工具 execute 可自行执行，底层业务无重复。最终本地 Scope 与 lease 在全局关闭前归零，最后 `close.ok/resourcesReleased=true`。被动记录保留实际执行参数、授权、完整 wire、业务、结果和释放顺序。

临时文件只在消费者目录创建，未访问用户业务文件。该文件夹具验证路径、权限与版本职责的归属，不替代真实 IDE 的业务验收。没有推导“所有文件应用已迁移”。

## 5. 现有回归、类型及复跑

最终干净重建实际命令/cwd/退出码见 [commands.json](../review-evidence/minimal-core-batch-23/runs/01/evidence/commands.json)，包安装、严格 App 编译及链路调用见 [consumer-commands.json](../review-evidence/minimal-core-batch-23/runs/01/evidence/consumer-commands.json)。实际 Node v24.15.0，TypeScript 5.9.3，Vitest 3.2.4。私有 pnpm 通过 Corepack 选择 10.33.2，与 B22 基线打包一致；未改共享依赖或配置。

基线与候选分别执行以下两个原测试文件，**每侧 42 项通过**，没有增加 skip 或改永久测试：

```bash
node node_modules/vitest/vitest.mjs run \
  src/adapters/semantic-aotui-driven-source.test.ts \
  src/adapters/semantic-aotui-driven-source.real-core.integration.test.ts \
  --reporter=dot
```

它们保留 instruction、instructionPath、环境变量的优先级、fallback、opt-out，以及 Source 身份、生命周期和隔离行为。另直接比较两包 `loadAOTUIInstruction.toString()`，完全相同，没有自动改写自定义说明。

实际 App 使用 `strict=true / skipLibCheck=false` 编译通过。保存了两侧各 **124 份**实际 Runtime 声明原件；只有 `adapters/system-instruction.d.ts` 中默认字符串的字面值改变，其他声明和 loader 签名不变。实际包也只差该文件的 JS、map、d.ts。[声明原件及比较](../review-evidence/minimal-core-batch-23/runs/01/evidence/declarations.json)

一键复跑：

```bash
python3 review-evidence/minimal-core-batch-23/reproduce.py
```

历史任务、分工、原说明、补丁、SDK/Runtime tar 和依赖清单按开工原 SHA 封存，入口核验历史原件，再单独记录当前共享输入。未来共享说明按批准改变或任务状态更新，不会要求共享文件永远保持旧 SHA；不会重写旧记录来迁就现状。

本次还在**私有影子目录**放入候选说明并改变一份活文档，再实际重新执行 prepare，签收 B22 基线 tar 仍精确重建成功。该结果证明历史入口不依赖当前文件仍旧，并不代表共享已落地。[私有落地后复跑模拟](../review-evidence/minimal-core-batch-23/runs/01/evidence/after-application-replay.json)

复跑需要已记录的本地第三方依赖和 Git 对象，不承诺无依赖机器上的联网安装。正式共享应用后仍应独立记录实际加载的是源码还是 dist，按共享现有版本复验；不会把本轮隔离 B22 的普通 Ref 成功反推为共享协议已有能力。

## 6. 中间失败和未执行项

完整可用中间记录在 `intermediate/`，包括：错误 cwd 的 build 命令未找到脚本；长 archive 路径触发 pnpm ENAMETOOLONG 后改用校验过的短路径 tar 副本；记录试件的语法错误；`Type.Unsafe` 普通 object 写法被现有 SDK 边界拒绝，改为其已支持的普通 object Schema。没有因此修改 SDK 或放松校验。这些均不是有效语义红灯或通过证据。

未运行真实模型、G3 作者试验、SRT-01 收口、全仓回归、GUI、真实 IDE、实网或发布。本轮没有重做 B22 内核回归和协议实现，也没有引入新的 Ref 采纳/释放规则。

**共享落地：PENDING_OWNER_REVIEW。** 唯一允许的后续应用，是负责人批准上述精确 patch 后，先核对当前共享 preimage，再应用同一说明文件并单独复验。当前交付停在 READY_FOR_REVIEW。
