# Wave 2B — 实测结果与证据层次

本次仅增加两个测试文件和本证据目录。**没有新增 Ref 解析执行能力，也没有修改生产代码。** 下列结果均为本批实际执行，不引用上批日志作为本批结果。

## 1. 新增合同探针

| 文件 | 当前最终结果 | 证明层次 |
| --- | --- | --- |
| `runtime/src/core/snapshot/ref-contract.wave2b.test.ts` | 17 passed | 真实 Core Store/validator/codec、实际 paramsToJsonSchema、实际 DOM Producer + LinkeDOM；App/View/Registry 输入为显式 fixture，非 SDK 挂载、非 Worker dispatch |
| `sdk/src/ref-contract.wave2b.test.ts` | 10 passed | 真实 SDK defineParams/validateArgs；没有调用 Hook/Host/Worker，没有解析或授权 Ref |

覆盖与限制：

| 场景 | 当前实测事实 | 对提案的含义 |
| --- | --- | --- |
| 双同类型 View、同名 file Ref | 各自 source owner 可精确取 A/B；A/viewInstanceB 拒绝 | 可以复用三元组查询，不需要新身份或后缀匹配 |
| Ref-only A→B | Snapshot ID 更新，views/tools 相同；旧值 A 深冻结且脱离原对象；新值 B；旧 Tool 来源仍可 acquire | 推荐传已授权的历史 A，不能自动替换 B |
| 同 viewId 重挂载 | 旧 Snapshot 旧实例仍可读 A；新 Snapshot 配旧实例、旧 Snapshot 配新实例拒绝；旧 Tool 来源获取拒绝 | 历史读取本身不是当前执行资格；不能把 resolved 状态当授权 |
| 缺 Ref/错误 owner/跨 App 或 AppInstance | REF_NOT_FOUND / VIEW_INSTANCE_REVOKED / APP_INSTANCE_MISMATCH | 复用当前来源查找失败；A 缺失时不会去 B 回退 |
| 错误业务类型、entity | resolveRef 返回 Todo tag/entity 描述符；没有资源读取和类型/权限判定 | **当前不支持通用 Ref 执行的这些拒绝规则**；提案需要新增 REF_TYPE_MISMATCH／REF_TARGET_UNSUPPORTED 等判断，不能说现有 Store 已拒绝 |
| 未知 kind／错 owner descriptor／额外 Schema 字段 | 当前 validator 拒绝 SNAPSHOT_INVALID | 不绕过 exact schema 塞字段 |
| 已 pin 历史源到期 | resolveRef 仍可读 A；新 acquire 和 acquireToolSource 拒绝 SNAPSHOT_EXPIRED；释放 pin 后 lookup 也拒绝 | 保留数据不提供延期授权；执行必须沿用 Wave 2A 授权后重新 acquire |
| App 停止 | 历史 Ref 数据可读，Tool source 获取拒绝 SNAPSHOT_UNREADY | “数据没有擦除”不能解释成 App 可运行 |
| reference 信息投影 | File/Todo/reference/string 可得到同一 JSON Schema；SDK 的 reference array 在 Runtime converter 不支持 | 不能从现有 Schema 自动恢复权威参数类别；数组暂不纳入首片 |
| 普通形似引用的 JSON | SDK validator 不改写 string/object/额外字段 | 当前仍为 caller JSON，不赋予来源能力 |
| 预算 | 140 KiB Ref 在 Snapshot 合法却超 args；70 KiB 同对象重复会超 bytes；重复节点超 nodes；嵌入 args 根增加 depth | 展开结果需聚合重新计费；这些是 codec 测试，没有实现展开器 |

## 2. 原始红绿轨迹

首次 Runtime 探针为 **16 passed /1 failed，exit 1**。失败仅在本批新测试手算 canonical 文本长度：预期 51，实际 52。独立用 Node `Buffer.byteLength(JSON.stringify(...),'utf8')` 核对为 52 后修正断言，没有改 codec 或任何生产行为；同一条“重复大对象必须超预算”的断言保持不变。原始输出保存在 `test-current-runtime-contract.log`，没有覆盖或删除。

另外把 DOM fixture 的 Fragment 补为实际的 view-state/timestamp 类型，并把 SDK table 的空数组用对象包装，确保真实验证数组而不是 Vitest 展开空参数行。它们都是本批新测试的编写修正，非产品 Bug 修复。最终分别为 17/10 passed，日志为 `test-current-runtime-contract-corrected.log`、`test-current-sdk-contract-corrected.log`。

所以本批不存在“产品修复前红、修复后绿”的主张。没有修改已经验收的测试期望，没有新增 skip/todo，没有降低 TypeScript 或质量门槛。

## 3. 按顺序执行的六项回归

| 顺序 | 实际命令 | 退出码 | 实际统计 | 原始日志 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm --dir runtime exec tsc --pretty false` | 0 | TypeScript 成功，非测试用例计数 | `test-final-wave2b-runtime-tsc.log` |
| 2 | `pnpm --dir sdk exec tsc --noEmit --pretty false` | 0 | TypeScript 成功 | `test-final-wave2b-sdk-tsc.log` |
| 3 | `pnpm --dir demo-apps/aotui-ide exec tsc --noEmit --pretty false` | 0 | TypeScript 成功 | `test-final-wave2b-ide-tsc.log` |
| 4 | `pnpm --dir runtime exec vitest run --reporter=dot` | 0 | **71 files /648 passed /3 skipped /7 todo**，总 658 cases | `test-final-wave2b-runtime-vitest.log` |
| 5 | `pnpm --dir sdk exec vitest run --reporter=dot` | 0 | **10 files /96 passed** | `test-final-wave2b-sdk-vitest.log` |
| 6 | `pnpm --dir demo-apps/aotui-ide exec jest --runInBand` | 0 | **6 suites /27 passed** | `test-final-wave2b-ide-jest.log` |

相对用户提供的 Wave 2A 验收基线，Runtime +17、SDK +10，均来自本批探针；skip/todo 不变。三处 tsc 检查范围仍遵循仓库配置（Runtime tsconfig 排除 `.test.ts`），不能声称生产 tsc 单独对测试源码作了类型检查。

`commands.jsonl` 保存每次运行的 argv、启动 UTC、退出码、耗时及日志路径；耗时仅是命令运行时间，不是产品性能数据。`run-check.py` 将真实 stdout/stderr 合并到独占创建的日志，并附 EXIT_CODE；不伪造摘要替代原始输出。

## 4. 兼容性复跑及层次

实际追加一轮 Runtime 定向复跑：**5 files /81 passed，exit 0**，包括本批 17 用例、source-binding 原 17 + Wave 2A 2、R1 29、Wave 2A 真实 SDK/Worker 16。日志 `test-compatibility-core-worker-r1.log` 使用 verbose reporter，可以定位每个用例。

其中，未改动的 Wave 2A 真实 SDK/Worker 测试再次证明：双 FileDetail 选中各自 Handler；旧实例/Tool binding/TTL/授权后失效拒绝；reference-shaped `[File B](file)` 原样到 A Handler；业务 success:false 沿 IPC 保持失败。**这是现有普通 JSON 链的兼容证据，不是提案的真实 Ref 解析 E2E。** 这一轮之外，未做三轮稳定性／性能 Gate；设计批次也没有要求以三轮替代真实执行实现。

另外，原始两个 R1 独立脚本未修改并在本批重新执行：

- `stage8/independent-review-20261023-01/lifecycle-terminal-race-real-worker.mjs`：**0/4 violations，exit 0**；新日志 `test-r1-original-real-worker.log`。
- 同目录 `lifecycle-terminal-race.mjs`：**0/10 violations，exit 0**；新日志 `test-r1-original-controlled.log`。

两个脚本导入的 Runtime dist 是本次顺序第一条 tsc 产物。原 ChatGPT 脚本及旧日志保留原样。

## 5. 未实现／未测试

| 项目 | 状态 |
| --- | --- |
| refSource API、x-aotui-ref 语义、授权 provenance、有效参数解析 | **NOT_IMPLEMENTED** |
| 提案的 SDK→Snapshot→Host 授权→Worker→Handler Ref 值全链路 | **NOT_TESTED / NOT_IMPLEMENTED** |
| 错 refType/entity 在新只读参数模式中 Handler=0 | **NOT_TESTED**；只验证当前低层 lookup 不承担此职责 |
| 新 32 bindings／合成 envelope／canonical 参数预算 | **PROPOSED / NOT_TESTED**；现有 copyJson 预算边界已单独验证 |
| 性能、CPU/heap、p50/p95、coverage | **NOT_TESTED** |
| 通用 entity 读取、跨 View/App、嵌套/数组 Ref、业务 typed Ref 注册 | **UNSUPPORTED / NOT_IMPLEMENTED** |
| 完整 M4／Strict／默认 Router 切换／可写开放 | **NO-GO；本批不申请** |

## 6. 工作树保护

起始保存了 1204 个已存在 tracked/nonignored untracked 文件的 SHA-256、完整 porcelain status、原 staged/unstaged binary diff；这些基线文件为只读。起始 HEAD/index/worker-host 指纹全部匹配用户预期。

最终保护结果由 `integrity-final.json` 与原始 `test-protection-final.log` 记录：要求 1204 个既有文件内容无变化、旧审计证据无变化、HEAD/index/worker-host 指纹一致，且新增文件仅为本证据目录和两份列明的新测试。未使用任何 Git 写入命令。`source-fingerprints.json` 给出实际保护结论与文件 SHA-256；`incremental-changes.patch` 只包含本批新增测试和设计文档，不把上批工作树差异重新算进本批，不包含会导致自引用的机器清单／日志。

本包只建议：**Wave 2B Ref 合同设计已交付，等待 ChatGPT 架构验收**。不宣告执行准出，不自动进入下一批。
