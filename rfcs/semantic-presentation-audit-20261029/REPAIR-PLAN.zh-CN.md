# Semantic 呈现修复方案

2026-10-29。依据本目录根因审计及用户“根据根因给出明确方案，然后开始修复”的授权执行。保留原审计和失败日志，修复结果另记。

本次目标是修复模型可见界面与 SDK 声明的一致性，保留 Semantic 的原观察调用、实例隔离、动态能力、收据、容量及关闭保证。Core 合同、真实业务状态来源和 Legacy 退出门槛不变；不导入用户旧数据库，不引入依赖或新框架。

| 交付 | 具体决定 | 准出条件 |
| --- | --- | --- |
| View 正文和包装 | 提取并复用旧适配器的单层包装能力，在 Presenter 统一处理 DOM 已有外壳与普通正文；保留 Producer 的既有输出合同，避免扩大迁移范围。内部 instance/revision 不写入正文 | 真实 SDK DOM 与普通正文输入都只包装一次，正文保留；同一正文不会因 App revision 更新而变化 |
| 公共 Tool 地址 | 按现有 Core 已聚合的逻辑 Tool 输出 `appName-ViewType-toolName`，不再按每个 Binding 都输出一个 hash 名。重复 App name 使用 App ID 区分；只有非法/超长/歧义名称才使用有界确定性后备名 | 常规名称逐字匹配；打开/关闭同类 View 不改变逻辑名称；没有覆盖和非法名字 |
| 多目标路由 | 多个可见 Binding 时，Schema 增加 `aotui_view_id` 枚举和必填要求；若业务已使用此字段，则加前导下划线直到不冲突。单目标保持原 Schema。Source 去掉其自己注入的选择字段，使用原 Context 捕获的 Binding 调用 Core | 缺失/非法目标在调用前拒绝；业务字段不丢失；A/B 不串目标；旧 Context 不重绑；关闭后旧调用仍拒绝 |
| SDK Tool UI | Tool UI 的存在只跟随声明的 enabled；所有受支持调用模式都可显示返回的组件。复用只读 Hook 已有模式 | enabled 切换时 UI 与注册表同步；ordinary-v1/v2 和 Ref 模式不因内部模式丢展示 |
| 说明、Desktop 与编排 | 恢复概念/结构/操作/Ref/收据说明及 instruction/path/env 优先级；恢复应用清单、有限系统日志和 `system-*` 控制工具名。instruction View 为 static、state 为 dynamic；时间以内容变化为依据，有界缓存仅服务展示 | 覆盖配置优先级、日志、顺序、不变内容、停用/释放；静态区仍是应用数据，不提升角色权限 |
| 应用页面 | 用当前 scoped owner 恢复 IDE 的 Workspace 目录标题、树形层次、打开文件列表和完整使用说明；Terminal/Browser 恢复说明章节和当前操作前置条件 | 真实三应用初始 Messages 可读；打开/编辑/关闭后的最新状态及动态工具正确 |
| 装配与验证 | 先构建 Driver，再构建 Runtime/SDK/应用/Host；Source 使用 Driver 同版本导出的 Tool 类型和 jsonSchema 工厂。对匹配源码构建隔离产物，运行默认 Worker/Host 链路 | 不借源码 alias 宣称产物通过，不覆盖共享 dist，不访问真实业务数据 |

多目标选择字段是适配器的公开路由字段，值为 View 中已经展示的逻辑 ID，不是 observationId/bindingId。模型不会生成内部身份。原来输入中的 filePath / view_id 等业务字段仍按当前已迁移应用合同执行，本批不恢复与“加载后才编辑”冲突的 Workspace 写入旁路。

实施顺序：公共呈现和 Source → SDK 一致性 → 应用正文 → 定向回归 → 隔离构建与真实 Host 验证 → 交付结果。旧审计探针固定在审计时语义，新增正式回归断言修复后的行为，不删除失败记录或削弱 Core 测试。

构建时修正：最初拟从 Runtime 本地 ai 直接导入 jsonSchema。真实构建发现 Runtime 与 Driver 安装的 AI SDK Schema 类型身份不同，这样做会产生 TS2322。采用 Driver 已有的导出保持同一类型来源，修正的是构建顺序和匹配产物验证，不使用类型断言掩盖差异。
