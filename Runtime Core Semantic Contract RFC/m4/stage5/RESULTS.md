# M4 Stage 5 — 版本化资源 Ref 与受控文件替换：实施验收

**阶段决策：Stage 5 版本化资源来源与受控文件系统联合测试 PASS；正式 Agent 写入 Tool / M4 全部 / Strict 仍为 NO-GO。**

- 日期：2026-10-23。本地 HEAD 789ef07；Node v23.11.0 / pnpm 10.15.1。
- 关联：[方案 B](../../07-view-owned-tool-identity-proposal.md) · [Stage 3](../stage3/RESULTS.md) · [Stage 4](../stage4/RESULTS.md) · [最终回归](./final-regression.log)
- 遵守 Minimalist：复用 Core Snapshot Store、现有 useDataRef / ViewTool、Node fs 原生 wx / rename / crypto，不新增依赖、Tool 基类或独立权限框架。没有触及 Mobile、Agent Driver。

## 1. 为什么要做这一步

Agent 在旧 Snapshot 中看见文件 App.tsx 的版本 A，此后用户把文件改为版本 B；如果 Agent 继续按照 A 覆盖写入，就会丢失用户最新的修改。

本轮明确了三个必须同时成立的条件：

1. View 来源必须指向 Agent 当时看见的 ViewInstanceId，同名 View 重建后不得重新绑定。
2. Ref 来源必须包含 File 实体身份和观察时版本，而不是无类型的活态对象或 Agent 自报哈希。
3. 真正磁盘写入时仍必须检查当前文件内容版本；Snapshot 记录是观察来源，不是操作授权。

## 2. 实际代码交付

| 层级 | 路径 | 真实行为 |
| --- | --- | --- |
| Pure Core | runtime/src/core/tool/source-binding.ts | 新增 acquireVersionedEntitySource；复用已提交 V2 Store 的 Lease、Tool/View 来源验证，读取同一实例版本化 Ref，比较最新 Ref 身份和版本 |
| Core Issue | runtime/src/core/snapshot/types.ts | 新增 RESOURCE_VERSION_REQUIRED 与 RESOURCE_VERSION_STALE 错误码 |
| SDK | sdk/src/hooks/useRef.ts、hooks/index.ts、sdk/src/index.ts | 新增 useEntityRef；复用 useDataRef 的 Layout Commit/注销；注册显式的 JSON 版本化实体标记 |
| Worker V2 Adapter | runtime/src/worker-runtime/dom-snapshot-producer.ts | 只对结构正确的显式实体标记产生 RefTarget.kind=entity；普通 Ref 仍为 snapshot-value，恶意 getter / 多余字段拒绝 |
| IDE File Adapter | demo-apps/aotui-ide/src/core/versioned-file-write.ts | readVersionedFile / replaceFileIfVersion：内容哈希、工作区边界检查、合作式排他锁、临时文件落盘与原子 rename |
| IDE Service | demo-apps/aotui-ide/src/core/file-system-service.ts | 仅显式提供上述可选方法；原有 write_file/edit_file/delete_file 和 Agent Tool Router 未改写 |

### 2.1 Core 来源不是授权

acquireVersionedEntitySource 只从 Runtime-owned 已提交的 V2 Snapshot 获取实体版本，要求 mutating Tool 和 versioned entity Ref，核对 AppInstanceId、ViewInstanceId、bindingVersion 以及最新 Snapshot 对应资源版本。缺版本、旧 View、被重新绑定的 Tool、实体变更和不同 App 均返回确定性失败；成功时提供只读来源描述与释放 Lease，不提供 Handler 或执行权限。

SDK useEntityRef 的 V2 JSON 标记有明确约定，无法从普通 Ref JSON 自动推断出写入权限。V1 混合 Legacy 路径仍把它看作普通 Ref 数据；不会自动转成可写 V2 Tool。

### 2.2 文件替换是合作式 CAS，不是万能的 OS 事务

受控 Adapter 的执行顺序：

- 真实工作区根目录和文件父目录使用 realpath 校验边界，禁止越界路径；拒绝最终 symlink、硬链接、非普通文本文件及超过 4 MiB 的目标。
- 文件版本采用 SHA-256 原始 UTF-8 内容哈希；未版本化文件不能作为此 API 的写入前置条件。
- 同文件路径采用 Node fs.open(flag=wx) 独占同名 .aotui-lock；锁内对比版本，创建同目录唯一临时文件，fsync 后再次核对目标内容和 inode，再用 rename 原子替换。
- 成功返回新内容版本；观察之后内容已变化时返回明确冲突，不写入旧内容。正常和失败路径清理临时文件与本次持有的锁。
- 没有注册任何新的默认 Agent 写入工具；旧 SDK TypeTool 的 mutating=true 也不会因此获得这个接口的授权。

**系统边界必须写清楚：** 这种合作式锁只序列化遵守同一 .aotui-lock 协议的写入者。完全不遵守锁的外部进程仍能在最后一次版本检查与 rename 之间发生竞争；Node wx + rename 不是跨所有进程的无条件原子 compare-and-swap。若要求绝对事务级并发语义，应使用共享的可信事务存储、所有写入者统一的锁协议或系统级原子条件更新。

其他限制：进程崩溃可留下锁而使后续写入拒绝（fail closed）；SHA-256 内容相同不能识别内容经历 A→B→A 的历史；rename 会替换 inode，不能承诺保留所有 ACL/xattr/外部打开句柄及目录断电持久性。它是受控文本工作区原语，不是通用文件系统沙箱。

## 3. 真正执行的测试与覆盖率

| 范围 | 新增证据 |
| --- | --- |
| Pure Core 来源 | 7 项：来自可信 V2 Store 的实体 Ref/Lease，缺少版本、错误实体、目标重挂载、Tool 版本、跨 App 拒绝 |
| Runtime Core + 实际磁盘 | 5 项：来源版本写入、旧操作重放拒绝、外部用户修改拒绝、View 重挂载、工作区越界保护 |
| SDK 真正 Preact/AppKernel | 2 项：useEntityRef 元数据注册，版本仅变化但 DOM 不变仍推进 Epoch；缺版本禁止发布 |
| Worker Producer | 3 项：entity / ordinary Ref 区分，Core 可发布的 V2 Draft，getter 和多余字段拒绝 |
| 真实 SDK + Worker + V2 | 扩展既有 E2E：版本从 A→B 经 IPC 发布，历史来源 version A 不漂移且被新版本拒绝 |
| 真 Worker + 真文件系统 | 1 项新 E2E：SDK View 声明真实文件版本，Worker V2 提交，Core 取得可信 File Ref，外部改动则拒绝写入，版本匹配时由显式文件 Adapter 修改；旧版本重放拒绝；Worker mutating Tool IPC 仍拒绝 |
| IDE 实际文件系统 | 11 项：排他锁/冲突/8 并发仅 1 胜、旧版本、越界、symlink 父目录、最终 symlink、硬链接、超大、无效 UTF-8、文件删除和已有锁 |

最终完整回归：[final-regression.log](./final-regression.log)。

| Gate | 实测结果 |
| --- | --- |
| Runtime TypeScript / SDK TypeScript / IDE TypeScript | 全部 exit 0 |
| Runtime Vitest | 63 files，**525 passed，3 skipped，7 todo** |
| SDK Vitest | 9 files，**86 passed** |
| IDE Jest | 6 suites，**25 passed** |
| 真 Worker + Core/文件系统与 IDE 文件测试 | 连续 4 轮全部通过：[复跑原始日志](./stability-reruns.log) |
| Runtime source-binding.ts 的定向覆盖率 | 95.38% statements/lines；92.72% branches；100% functions |
| SDK useRef.ts 的定向覆盖率 | 100% statements/branches/functions/lines |
| IDE versioned-file-write.ts 定向覆盖率 | 93.22% statements；82.35% branches；100% functions；96.36% lines |

相比 Stage 4 的 Runtime 509 / SDK 84 / IDE 14，本轮分别新增 16 / 2 / 11 项通过用例。覆盖率只代表指定文件，不代表整个 IDE 文件服务或整个 Runtime。

## 4. 诊断性能（非产品预算）

[脚本](./benchmark.ts) · [原始结果](./performance.log)。本机临时工作区，每组 5 次预热、20 次采样；内容版本读取 + 合作式锁 + fsync + rename。

| 文件大小 | 版本读取 p50 / p95 | 版本替换 p50 / p95 |
| --- | --- | --- |
| 1 KiB | 0.159 / 0.261 ms | 3.764 / 4.383 ms |
| 64 KiB | 0.226 / 0.293 ms | 3.870 / 4.626 ms |
| 1 MiB | 0.952 / 1.219 ms | 7.989 / 9.212 ms |

没有纳入真实 IDE/LSP、Worker 授权、跨平台文件系统、模型调用或大型工程负载；不能用这些数字承诺生产 p95。

## 5. 未关闭的 Gate

**Stage 5 的版本化来源选择及受控文件替换 = PASS；完整 M4/Strict/默认 Agent Mutating Tool = NO-GO。**

当前未准出的重点：

- Agent→可信 V2 Snapshot→业务权限→活态 Handler→真正磁盘写入的完整授权及并发取消尚未正式接线。新受控文件适配器由测试中的可信调用方使用，绝不冒充默认写文件 Tool。
- 旧 Agent write_file/edit_file/delete_file 仍没有来源绑定与版本 CAS；本轮不改变这些现有 API 的默认行为。
- 真正的 SDK CaptureBarrier、第三方 Hook 异常与未通知的对象原地变化、非 JSON 资源编解码没有全面准出。Shadow report 仍 producerConsistency=unverified、strictEligible=false。
- 不合作的外部写入者、ACL/xattr/崩溃遗留锁、巨量文件及真实 IDE/LSP 多进程工作流仍需独立验收。
- Host/DOM/模型厂商可替换性的完整 P1 Semantic Runtime Core 与另一个正式运行 Adapter 尚未全面迁移；Node 本机 v23 而非原目标 >=24。

没有 Git stage、commit、reset，也没有清理用户原有未提交内容；没有留下后台工作。
