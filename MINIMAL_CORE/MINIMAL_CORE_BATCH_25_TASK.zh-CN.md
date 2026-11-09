# Batch 25：真实 Host 中可操作的 Ref 验收入口

**AUTHORIZED_ISOLATED_ACCEPTANCE_PREPARATION。** 所有者在 SRT Owner chat 明确要求给运行中的 Host 安装 Planning 以测试 Ref，并追问“那我怎么验收 Ref”。双方已确认：共享 Planning 当前只发布引用，业务仍传 ID。当前优先交付可实际启动的隔离验收环境，复用已批准候选，不把它默认为共享采用。SRT Owner 负责独立复核和用户验收说明，Minimal Core 负责组织这一入口；B24 只读结果保留并交审，不扩大成集成改造。

## 可运行结果

在持久的项目内独占目录 `.tmp/minimal-core-ref-acceptance-20261106/` 交付启动命令及真实 Host。采用 SRT M4.3 的现有 Host 与真实 Planning 源码，Planning 的一个 `open_plan` 工具接收必填 Plan Ref；页面发布完整名字，Runtime 取出原观察中的 Plan，应用按自身规则检查并打开详情。Agent 仍看到收据与新的 View，不在收据重复正文。

精确 SDK tar 使用 B22 已签收的 `c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff`；Runtime 可直接使用 B23 已签收 tar `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6`（B22 核心加已审说明，未再改核心）。包原件分别位于 B22/B23 `runs/01/artifacts/`。不因版本字符串相同而混用 SRT 原包、共享旧包与候选包。

## 所有权和范围

- 执行者只在该隔离环境和自己的准备目录编辑。SDK/Runtime 核心源码和包载荷不修改、不重打；root 的 SDK/Runtime/Host/Planning/启动脚本不修改，SRT Owner 正在完成共享 Planning 安装，不与其并发改文件。
- Planning 从真实 SRT M4.3 提取，只改一个工具的声明和业务绑定，并复用既有已审 RefValue/Plan Schema 试件。局部试件不成为公共 SDK helper，不新建协议。保留其他操作的现有业务参数；必要时复用已签收 B13 页面补丁，明确记录。
- Host 复用现有实现。若默认硬编码全局配置或 profile 路径，只允许在隔离 Host 副本做最少的路径配置；每个修改给出原因、原件和差异。优先使用已有选项。不得修改 HOME、重建共享依赖或引入新宿主框架。
- 保留用户现有 config、聊天、Planning 数据和当前 Host 进程。使用独立配置、聊天数据库、Planning 数据目录、Electron profile；不得 kill/restart 当前 Host，不复用其可写数据文件。明确哪些模型配置可由用户自行设置或在不打印凭据的前提下安全复用；默认禁用无关 MCP/IM/后台动作。不得发外部模型请求。

## 准出条件

1. 实际包安装及逐文件指纹验证，Host/Planning 实际解析到本批指定 SDK/Runtime，禁止由源码链接悄悄落回共享旧包。普通第三方依赖可复用，但记录实际来源，不修改共享安装。
2. 真实 Planning、Node Worker、Source 验证：创建一条验收数据、关闭详情、取得 PlanList 完整 Ref，再通过 `open_plan` 打开正确详情；业务实收原观察中的 Plan，应用仍检查当前是否可打开。收据不重复业务正文。
3. 错误前缀、未知名字、直接上传对象均在业务前拒绝；关闭/删除后遵守现有绑定或业务检查。不得宣称数组整体、组合/可选 Ref 或 SRT-05 新观察自动使旧 Context 失效已经完成。
4. 独立数据目录与原数据保护有实证；启动命令可执行，实际 Host 能打开验收 App。GUI 验证不发模型请求；若当前环境无法启动某个界面，要给出具体阻断，不能把编译成功当作可运行 GUI。
5. 交付一个清楚的入口、需要用户做的最少操作、应看到的 View/工具/收据，以及精确包身份、可复跑正反例、启动与关闭本环境的方法。所有测试只写验收数据，用户当前 Host 不被停止。保存 B24 已发现的共享采用风险，不将隔离手测视为正式集成。

执行者交 READY_FOR_REVIEW，由 Minimal Core 复核应用与执行证据，SRT Owner 独立核对隔离/Host/用户验收入口。开发执行者不能自行批准。无 commit/push/merge/发布；最终 Semantic 验收由所有者完成。

## Codex Prompt

先把 B24 已有只读结果简洁封存为 READY，不继续扩大盘点。随后优先执行本批：使用已经签收的精确包，在隔离 Host 接入真实 Planning 的一个必填 Plan Ref 工具，让用户实际能测试。你不是唯一工作者，不覆盖 SRT Owner 的共享安装修改；核心和现有用户数据保持原样。交可启动环境、真实链路正反例和准确限制，由两位负责人分别独立复核。不要另写协议，不做新的外部模型试验。
