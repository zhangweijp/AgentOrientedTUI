# 迁移到当前作者入口

当前只推荐 [静态声明 → App 绑定 → View 投影](view-type-tools.md) 这一流程。先按 [包使用说明](runtime-compatibility.md) 使用同次交付的 Runtime／SDK，再迁移应用；仅升级声明或能 import 并不证明 Worker 支持新合同。以下是当前替换方式，不提供旧入口兼容包装。

| 旧写法或职责 | 当前写法 |
| --- | --- |
| 每个 View 实例调用 useViewTypeTool／useViewSnapshotTool | module-scope `defineViewTypeTool` + `defineToolSet`；每个 App 一个 `AppTools`，普通 TS 用 `createToolBindings` |
| definition 内含 execute | definition 只含 viewType、name、description、inputSchema；execute／enabled 放入 App bindings |
| 重复维护 Schema、参数类型、注册和工具说明 | 一份 TypeBox Schema 推导 `ArgsOf`／`SchemaOf`、注册和参数合同；handler 参数递归只读 |
| isMutating 分类 | 删除该字段；只读参数、授权、业务 effects 及调用终态各守原合同 |
| Root／数据 View 重复序列化完整工具定义 | Root 用 `ToolCatalog` 按类型列工具名；完整描述与 Schema 只进入 Context Tools |
| 用实例 id 猜 ViewType／扫描后代猜 kind | 显式 View `id`、`type`、`kind="instruction"` 或 `kind="state"`；同类型多个实例共享工具 |
| App 自行包装 `<view>` 或预转义 XML | 只提交正文；最终消息边界包装并编码一次，文件／日志原文放 pre/code |
| ToolResult 的 success/error/effects 任意组合 | 以 success 判别；失败提供 JSON error；成功不带 error/effects；无法确认副作用时不伪造 none |
| Registry 为读名称 import App，或注册配置覆盖名称／说明 | 先构建生成 aoapp.json；Registry 只读静态输出，注册 key 使用 canonical app_name，说明仍只维护在工厂声明 |
| AOTUI_APP_NAME 同时充当运行名称和状态 namespace | canonical app_name 由生成物核对；需要独立状态 namespace 的 Host 改传 AOTUI_APP_KEY，旧字段明确拒绝 |
| ToolResult 携带完整文件正文或列表 | 返回短收据及必要提示；当前业务数据进入 View |
| 让模型抄 plan_id／phase_id／task_id 选择已展示对象 | 发布对象／数组 Ref，参数用 `refParam`，App 从解析对象读取内部身份并校验当前状态 |
| 把 Note:current／Note[]:notes 当作调用输入 | 这些是展示提示；调用使用 `detail.current`／`detail.notes`，以所属 View 实例 id 定位 |
| getContext 后直接调用，或只预览就替换旧资格 | 可信消费者显式 `Context.adopt()`；Driver 自动采用；finally 释放该 Context |
| 从 @aotui/runtime/adapters 导入 SemanticAOTUIDrivenSource | 从独立 `@aotui/agent-driver-adapter` 导入，Host 安装匹配 Runtime／Driver peer |

文件路径、标题、编辑内容和金额有独立业务意义时仍用普通参数；Ref 不是替代所有字符串的新类型系统。Ref 支持对象、整数组、元素、多个／可选与地址数组多选；使用方式及不支持的查询见 [Ref 指南](readonly-ref-v2.md)。

静态声明不捕获业务实例；完整映射一次绑定到 App。将同类页面中的重复注册合并到共同祖先的 AppTools。同类型最后一个 View 关闭后 activation 失效，重开不恢复旧资格；App 仍检查路径是否打开、对象归属、版本和权限。不要把共享工具改为隐式绑定某个页面或文件。

`createToolBindings` 的 controller 对声明 Map 不变；不要把它强转成另一套 Schema。绑定提交、失败关闭和 cleanup 细节见 [普通 TS 绑定](binding-tools.md)，组件行为见 [AppTools](app-tools.md)。旧 ToolUI 不能授予权限；可选 ToolRef 只呈现局部能力标签，不承担注册。

迁移后运行 [文件 App](examples/file-app.tsx)、[笔记 Ref App](examples/ref-app.tsx) 与现有包消费者检查。验证打开后能力出现、数据更新只呈现最新快照、关闭后旧资格失效、合法业务失败和资源释放。历史阶段方案及签收记录只说明当时产物，不作为当前推荐教程或本次验收结论。

本次为 Breaking Change：匹配组合是 Runtime 7.0.0-srt.1、SDK 0.8.0-srt.1、可选 Adapter 0.4.0-srt.1 与 Driver 0.3.0。工厂和注册端口统一引用 Runtime 的 view-type-tools-v4 常量；旧 v3 及更早工厂／端口不会获得兼容执行。重新构建工厂及生成清单，不手动修改协议字符串。

Worker INIT 必须请求并确认 app-snapshot/v3；启用工具时还必须确认既有 view-tool-parameters-invoke/v4。缺失 Snapshot 支持或未确认全部请求能力时，在 OPEN/调用前拒绝。Snapshot 数据本身仍逐份独立校验，不以握手代替来源、参数、Ref 或预算检查。低层 ComponentFactory／纯 Core Producer 的身份与生命周期保持独立，普通 TS 的现有注册端口也使用同一个常量源。

旧 Registry 的 package.json/index.js 回退不再用于发现应用；缺失或无效 aoapp.json 给 APP_MANIFEST_INVALID。直接 Runtime Worker 安装入口仍可使用明确的模块路径，Worker 核对工厂协议和调用／Snapshot 支持。现有 SDK 文件／Ref 示例属于这种直接安装场景，不需要为了运行示例先引入应用市场。
