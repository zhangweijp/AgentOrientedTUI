# MC-HOST-PREVIEW-01 隔离预检独立裁决

2026-11-06。**CHANGES_REQUESTED：不批准恢复第三轮 Host 行为诊断。** [前两轮事故裁决](MINIMAL_CORE_HOST_PREVIEW_INCIDENT_REVIEW_2026-11-06.zh-CN.md)保持封存。预检成功复现了隔离限制，不能把预检命令 exit 0 写成隔离通过。Host 预览缺陷仍没有获得有效的新探针复现。

Minimal Core Owner 阅读执行者模拟脚本后，在另一个全新目录为每个场景分别创建 allowed/denied 文件，独立运行五种场景。全部输入都是本次自建的普通测试文本；没有导入 Host/Runtime、读取用户状态、启动 GUI 或调用模型。Node 版本为 v24.15.0。

| 场景 | 实际结果 | 可支持的结论 |
| --- | --- | --- |
| 主线程直接读取、写入 | allowed 操作成功；禁区的同步、Promise、callback 读写、ESM import、CJS require 报 ERR_ACCESS_DENIED | 这些直接调用受当前允许列表约束。 |
| allowed 内链接到 denied 文件 | 实际读到合成禁区文本 | 路径允许列表不能作为本轮所需的完整文件隔离。 |
| Worker 默认继承启动参数 | 五项禁区操作全部拒绝 | 本次默认继承场景有效。 |
| Worker 显式 `execArgv: []` | 权限未启用；五项禁区操作成功，包括模块顶层执行和写入 | 不能只检查主进程参数，就保证所有 Worker 都受保护。 |
| 子进程及原生 addon | 未授权时拒绝；本次获准启动的两个 Node 子进程场景仍继承/显式使用权限，拒绝合成禁区读取 | 不推广为所有子进程、环境变量配置或原生代码均安全。 |

固定 B23 Runtime 的两个实际 Worker 创建点已静态读取：`engine/app/worker-pool.js` 与 `engine/app/worker-host.js` 都没有主动清空 `execArgv`。因此上表不是“已发现本次 Runtime 必然绕过权限”的断言。它说明当前进程权限方案的边界；尤其符号链接读取已经实际越过模拟禁区。本次不据此扩大为 Runtime 安全体系重设计或新生产修复。

独立重跑在 `.tmp/minimal-core-host-preview-owner-preflight-20261106` 的五个独立子目录完成，避免前一个场景的文件写入影响后一个场景。复核断言确认：合成 private.txt 没有被覆盖；只有清空 Worker 参数的场景产生了禁区写入文件和模块顶层执行标记。原始 stdout、stderr、启动命令、来源脚本 SHA 与解析结果保留在 [permission-replay-result.json](../review-evidence/minimal-core-host-preview-20261106/owner-review/permission-replay-result.json)，只读可审查脚本为 [replay-permission-preflight.py](../review-evidence/minimal-core-host-preview-20261106/owner-review/replay-permission-preflight.py)。脚本的产物只写入负责人自己的合成目录和复核证据目录。

替代环境尚未确认可用。此前本机 sandbox-exec 的合成预检因 sandbox_apply 权限限制退出 71。另以自己创建的空 Docker 配置、明确的本地默认 socket 做了只读连通检查，该 socket 不存在。没有读取用户 Docker 配置、尝试其他用户上下文、启动 Docker、下载镜像、扩大权限或运行 Host。这些结果不等于整台机器或其他环境没有可用容器，只表示本次没有取得可准入的替代环境。

原事故的未知项保持不变：首轮用户 App 配置读取及四个模块的动态导入已确认，缺少完整 I/O 审计和事前私有文件指纹，无法排除额外副作用。后续的模拟预检不能倒推首轮完全没有影响；不会通过再次扫描私有目录补造保证。

SDK、Planning 和 GUI 的既有技术签收范围保持不变。它们不是本轮诊断脚手架的修改对象，也不因为预检暴露限制而自动被视为共享采用、发布或最终 Semantic 验收。

下一项只做**静态责任链与可审查修复建议**，由执行 Codex 使用已取得的公开静态基线完成，Minimal Core 独立复核。准出条件：准确区分已记录的历史 GUI 症状、源码可证明的缓存/事件行为和仍待运行验证的推断；列出首次读取、提交后更新、持续停留页面三种路径的状态所有者；给出最小文件范围、修复设计、必要行为验收和尚需的隔离运行条件。不得执行 Host/Runtime，不修改生产源码，不把静态推断升级为已复现或已修复。

执行 Prompt：

> 在现有新独占诊断目录完成 MC-HOST-PREVIEW-01 的静态报告。封存两轮失败与全部权限预检，引用 Minimal Core 两份 CHANGES_REQUESTED 裁决；不再导入 Host/Runtime 或运行 Worker 业务。沿真实 Host getSnapshot、Bridge snapshot 缓存、Session 事件和 renderer 请求入口，说明页面为什么可能停留在旧值，分别列出直接代码事实与尚待验证推断。提出最小修复文件及行为方案，保持 App 不承担等待/轮询，GUI 预览不替换 Agent Observation，不加状态管理器或协议扩展。提交精确基线/源码身份、带位置的责任链、下一阶段必要验收、独立且不挂载个人数据的运行环境要求和实施 Prompt。不得把未成功的复现写成通过，不自行启动新环境、下载镜像、扩权或采用修复。交 READY_FOR_REVIEW。
