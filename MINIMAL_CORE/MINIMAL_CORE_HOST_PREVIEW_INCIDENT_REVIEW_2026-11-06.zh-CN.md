# MC-HOST-PREVIEW-01 诊断隔离事故复核

2026-11-06。**结论：CHANGES_REQUESTED。** 本记录针对后续 Host 预览诊断脚手架及其前两轮失败，不改写已签收的 SDK、Planning 和受控 GUI 裁决。当前尚未获得有效的预览缺陷复现，MC-HOST-PREVIEW-01 继续 OPEN。下一轮 Host 行为运行已经要求暂停，先完成隔离保护的独立准入检查。

执行 Codex 的授权是：在新独占目录使用合成数据，只读诊断真实 Host/Bridge，不读取用户私有配置、profile、数据库或凭据，不启动 GUI、外部模型，不修改共享生产代码。首轮违反了约定的用户配置读取边界。执行者主动报告后，Minimal Core Owner 独立检查原始命令结果、脚本和对应实际源码，并将事故向项目所有者说明。

已确认的调用链是：诊断脚本导入 M4.3 `host/core/desktop-manager` → 模块顶层创建全局 `DesktopManager` → 立即异步 `initialize()` → 默认 `AppRegistry.loadFromConfig()` → `getDefaultConfigPath()` 使用 `process.env.HOME` 构造用户级 `.agentina/config.json`。脚手架只替换了 `os.homedir()`，没有覆盖该路径来源。默认配置随后驱动 `loadFactory()` 的动态 `import(modulePath)`。

原始命令输出确实记录了 system_ide、terminal、lite_browser、planning_app 四个 Loaded app。不能把这些日志解释为仅注册了名称：动态导入意味着模块顶层代码可能执行。现有证据没有记录这四个 App 由该 singleton 安装到 Desktop 或创建其 Worker；但首轮没有完整的文件访问审计，也没有用户文件事前指纹，**不能排除模块顶层额外读取或写入，不能保证用户原状态完全未变**。不通过事后扫描用户私有目录追补这种无法还原的事实。

首轮脚本在导入 Host 前，将 `DB_PATH` 和 `AOTUI_DATA_DIR` 指向自己的 `run-01`，替换进程内模型 Provider 并阻断所列主进程网络入口。实际测试 App 因缺少本地 typebox 而未加载，正向对照未出现 PRELOADED_PLAN，Node 最终 exit 1。请求数组为空；trace 中 Runtime 的关闭回执只属于该脚本显式持有的 Runtime，不能证明意外导入模块的所有副作用均已审计。原命令输出没有打印用户配置正文或真实凭据；这也不等于这些内容从未被进程读取。

第二轮在暂停指令到达前已完成，执行方报告时间线与封存日志一并保留。它在 Host 导入前把默认 Registry 配置路径改到自己的合成配置，并增加了部分 fs 包装。实际创建了两个合成 Session/fixture Worker；预加载正向对照能在第一次预览看到 PRELOADED_PLAN。随后探针错误地用业务名称 `preview_fixture` 查询实际为 `app_0` 的实例，抛出 TypeError；异步业务数据尚未释放，所以仍不是目标预览缺陷复现。Node exit 1，外层 Python 日志包装 exit 0，二者不能混记为测试成功。

第二轮的 fs 包装不构成充分的隔离证明：覆盖了部分同步/Promise 方法，未覆盖所有 callback、动态模块加载及 Worker/子进程入口；基于字符串路径前缀的判断也需要处理符号链接和非字符串路径。零次命中此包装器只能说明它覆盖的入口未记录拒绝，不能推导零次私有访问。后续不把这一包装器继续扩展成一套自制文件系统安全框架。

Minimal Core 已在自己创建的模拟文件上测试本机 `/usr/bin/sandbox-exec`，仅测试额外的文件读取限制，未导入 Host。操作系统返回 `sandbox_apply: Operation not permitted`、子进程 exit 71。此失败属于环境能力限制，证据保留；不扩大权限，不转而探测真实用户路径。接着评估 Node 自带权限允许列表，在自己的模拟目录证明边界后再决定是否恢复诊断。

证据位置：[首轮原始命令结果](../review-evidence/minimal-core-host-preview-20261106/owner-review/first-run-output-proof.json)、[首轮脚本与失败](../review-evidence/minimal-core-host-preview-20261106/intermediate-failures/01-missing-local-dependencies/result.json)、[第二轮失败](../review-evidence/minimal-core-host-preview-20261106/intermediate-failures/02-wrong-app-instance-id/result.json)、[OS 沙盒预检](../review-evidence/minimal-core-host-preview-20261106/owner-review/process-sandbox-preflight/result.json)、[独立取证指纹](../review-evidence/minimal-core-host-preview-20261106/owner-review/incident-evidence-hashes.json)。已签收源码/GUI 报告与 GUI final-signoff 的指纹再次核对未变；这证明签收材料未改，不替代对私有运行状态的证明。

下一项范围由执行 Codex 负责：封存两轮真实脚本、输出、命令和退出状态，完成**不导入 Host/Runtime、不接触真实私有路径**的 Node 权限预检。Minimal Core 独立复核，执行者不得自行批准恢复 Host 诊断。准入条件如下：

- 允许列表只包括该次诊断的公开静态文件、必要依赖和合成运行目录；不以整个仓库或用户目录作为读取授权。
- 自己创建 allowed/denied 模拟资源，验证同步、Promise、callback、动态 ESM import、符号链接、Worker 的实际读取/写入边界。子进程与原生 addon 默认禁止，确有需要再提供可审查依据。
- 正向允许操作成功，越界操作在访问前失败；测试自身不得通过读取实际用户配置来证明阻断。
- 完整记录使用的 Node 参数、版本、边界和剩余限制；不同线程或进程不能静默放宽权限；不修改 HOME。
- 不把模块加载失败、测试程序自身错误或退出包装器的 0 当作诊断通过。依赖与实例身份必须先在合成资源上自检。

本阶段执行 Prompt：

> 保留 run-01、run-02 原始证据，区分已证实访问、日志没有记录和无法确认的副作用。只在你独占的诊断目录准备权限预检，优先使用 Node 内建权限允许列表，禁止读取真实私有路径或导入 Host/Runtime。以合成 allowed/denied 资源验证主线程、动态 import、符号链接与 Worker，证明正常读取可以继续而越界读写被拒绝。提交精确启动命令、预检原始结果、后续 Host 诊断拟用允许列表及限制，状态 READY_FOR_REVIEW。独立准入复核前不得运行下一轮 Host 行为探针，不改任何生产源码或既有验收材料。
