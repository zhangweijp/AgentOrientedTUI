# 08 · 保持 Ref 能力的显式作者作用域

文档 ID：AOTUI-D08 · 修订：0.5 · 更新：2026-11-18（Asia/Shanghai）

**第三批已验收。** 现行 SDK 会告诉作者哪个 Ref hook 缺少父 View，以及应把调用移到哪个组件。作者可以用原有声明完成修复。如果后续多个真实 App 仍难以组合页面与其引用，再用相同的作者任务比较 `View.refs` 等候选入口。

## 状态与范围

| 项目 | 当前记录 |
| --- | --- |
| 状态 | “作用域明确、容易组合”方向获认可。现有 hook 诊断和安装包示例已验收，新增作者 API 待讨论 |
| 验收基线 | `90449dc2d` 加前三批工作树改动，SDK 0.9.0、Runtime 8.0.0、Preact 10.29.1 |
| 最近讨论 | 2026-11-18，Asia/Shanghai |
| 本文负责 | 作者如何把 Ref 归到页面并组合内容；不改变 Ref 解析语义 |
| 相邻议题 | [06](06-preact-semantic-bridge.md)负责提交一致性；[07](07-dom-adapter-boundary.md)负责正文序列化 |

Preact 仍是当前默认作者入口。本文只讨论在现有能力上降低作者负担；不借此缩小 Ref 值域、取消跨 View 选择，或重定向到最新数据。

## 用户原话与不可更改的前提

> 8. “Ref 的作用域应该显式、容易组合” 没问题，有更好的方案吗？在不破坏 Ref 现有能力的前提下。

> 11. Ref 的显示地址与调用地址 不能统一，这是我的设计。

> AOTUI 的一个 View 实例 对应的 就是 GUI 网站内/桌面应用的一个页面

因此页面可以同时展示多个文件、搜索结果和操作提示，业务对象也可随页面内容切换。改进的目标是让作者清楚“这些 Ref 属于哪一页”，不是要求页面固定绑定一个对象。

## 先看 Files 与 Editor 的连续操作

Files 页是 `view_id=files`、`type=FileList`，发布 `results` ArrayRef，显示 `[测试文件](File:results[0])`。这段展示包含类型和局部名称；模型调用时填写 `files.results[0]`。两者严格不同，不因新作者 helper 而合并。

Editor 页是 `view_id=editor`、`type=FileDetail`，先显示 `test.txt`，也可以在同一页切到 `notes.txt`。例如一个示意切换操作接收：

```json
{ "view_id": "editor", "target": "files.results[0]" }
```

这里 `editor` 选择执行页面，`files` 选择 Ref 的来源页面。业务参数名 `target` 只是例子，不规定当前工具名，也不强制所有文件路径改为 Ref。只要处于同一 App 实例和同一原观察，跨页选择就应继续有效；选 `notes.txt` 时可以换成该观察中的 `files.results[1]`，不需要更换 Editor 的页面身份。

这说明作用域需要解决两件事：作者能明确声明列表引用属于 Files；运行时能独立校验接收页面和数据来源。**改善声明位置不能改变调用含义。** 模型本轮输入开始生成后固定，列表即使后台重排，原调用仍解析原 Observation 的值；App handler 使用当前页面闭包与服务，再检查对象、权限及文件版本。

最终 View 仍以 XML + Markdown 包装成 User Message，既提供当前事实也构成 Agent 的工作记忆；Tool 只返回结果与提示，正文变化在 View 中呈现。FileDetail 工具按 App + ViewType 共享，页面打开且满足实例条件才激活。这些约束都与采用 hook 还是 descriptor 无关。

## 现状与具体摩擦

[useDataRef](../../sdk/src/hooks/useRef.ts)和 [useArrayRef](../../sdk/src/hooks/useArrayRef.ts)从 [ViewRuntimeContext](../../sdk/src/contexts/view-runtime-context.ts)取得注册器；[View](../../sdk/src/components/View.tsx)在自己的返回子树中设置 Provider。因此在没有外层 View 的页面组件中，先调用 `useDataRef`、再返回 `<View>`，并不能得到该 View 的作用域。

```tsx
// 当前不成立：hook 执行时，这个 View 的 Provider 还不在祖先树上。
function FilesPage({ results }) {
  const [, item] = useArrayRef('results', results, { itemType: 'File' });
  return <View id="files" type={FileListType} kind="state" context={services}>
    <p>{item(0, '测试文件')}</p>
  </View>;
}
```

现行可靠写法是 View 外壳加内部 Content 组件，[工作项 Preact 样例](../../sdk/tests/fixtures/work-items-preact.tsx)已经使用这个模式。它符合 [Preact Context 文档](https://preactjs.com/guide/v10/context/)的祖先 Provider 规则，不是 Preact 故障；但“一个页面声明自己的引用”需要额外组件层，是可以改善的作者成本。

普通 TS 的 [refs.ts](../../sdk/src/app-factory/refs.ts)已经提供 `ref/arrayRef/formatRef`，并在 [createApp.ts](../../sdk/src/app-factory/createApp.ts)中把 descriptors 捕获到所属页面。这是可复用基础，不必再造 Ref 类别。

缺少上层 Provider 时，SDK 现在报告调用的 hook，把可安全显示的短局部 Ref 名带入提示，并指导作者把 hook 移到由 `<View>` 渲染的内容子组件。此前提示只有 `Ref Hooks must be used inside a mounted <View>`。新提示说明返回 `<View>` 的函数为什么读不到它自身创建的 Provider。诊断只用 hook 名和可靠的声明位置提示作者。Runtime 的现有安装诊断继续传递这条消息。[SDK 用法](../../sdk/README.md#ref-与参数)、[作用域检查](../../sdk/src/contexts/view-runtime-context.ts)

## 方案比较与建议

| 方案 | 收益与局限 | Agent 作者成本 | 即时与长期维护 | 适用条件 |
| --- | --- | --- | --- | --- |
| A. scoped child：View 外壳 + Content | 复用当前 hooks 和作用域，能力已具备 | 多一个组件；作者需理解 Provider 位置 | 现在无需新增机制；长期增加的是模板与文档负担 | 页面本来就有独立子组件，现行模式足够清楚 |
| B. descriptors + `View.refs` | 同一函数表达页面、正文与引用；保留现有捕获语义 | 学一个 prop，少一层强制包装 | 近期需接入现有 owner 与重名检查；长期承诺较小，但不能形成第二注册表 | 简单页面经常因 scope 拆组件；本文首选候选 |
| C. 纯 render scope | scope 参数显式，方便组合无状态内容函数 | 要区分纯回调和真正组件；不能在回调里随意用 hooks | 近期需定义 scope 有效期；长期若与 B 同时公开会增加重叠 API | 多个纯内容函数确有共享页面作用域需要 |
| D. `useViewBinding` 显式 handle | 可跨较复杂的作者层次传递页面绑定 | 多学习一种身份与释放规则，容易误复用 | 当前成本最高；长期必须维护 handle 生命周期和错配诊断 | 现有 descriptors/context 不能表达已出现的必要组合场景 |

显式 descriptor 借鉴成熟的声明数据与执行分离方式；Context scoped child 则直接复用现有组件能力。没有现成库能无条件提供 AOTUI 的原观察解析和跨 View 合同。优先复用现有捕获函数，把新 API 做薄，而不是增加另一份注册表。

按 Minimalist，A 是已经存在的基线；B 只在已有捕获之上减少声明摩擦，不应重写 Ref 内核。C/D 不能仅因为“更灵活”就一起加入公共 SDK。**建议先改善 A 的诊断，用相同页面任务与 B 比较；B 仍是优先研究的作者 API 候选，当前开发继续使用现有 hooks，批准与实现另行决定。** 两种写法若并存，最终必须交给同一个 View owner、同一重名检查和同一 frame，而不是两条 Ref 生命周期。

## 拟议作者体验

以下 `View.refs` 与默认入口的 descriptor 导出均为**拟议 API**，尚未实现。`ref/arrayRef/formatRef` 的底层能力已存在于普通 TS 路径；推荐复用它们，不额外引入 Ref 格式或解析器。

```tsx
function FilesPage({ results }) {
  const entries = arrayRef('results', results, { itemType: 'File' });
  return <View id="files" type={FileListType} kind="state"
    context={services} refs={[entries]}>
    <p>{formatRef('全部搜索结果', entries)}</p>
    <ul>{results.map((file, index) =>
      <li key={file.path}>{formatRef(file.label, entries, index)}</li>
    )}</ul>
  </View>;
}

function EditorPage({ selectedFile }) {
  const current = ref('current', selectedFile, { refType: 'File' });
  return <View id="editor" type={FileDetailType} kind="state"
    context={{ selectedFile, fileService }} refs={[current]}>
    <p>{formatRef(selectedFile.path, current)}</p>
    <pre>{selectedFile.content}</pre>
  </View>;
}
// selectedFile 可从 test.txt 切为 notes.txt，editor 仍是同一个页面。
// Files 展示：[测试文件](File:results[0])
// 跨页调用示意：{ view_id: 'editor', target: 'files.results[0]' }
```

descriptor 只是作者声明。数据在 render 候选阶段按现有 JSON 规则捕获，真实 commit 后与对应正文一起发布；不能在 render 时直接改变当前已发布 Ref，也不能等到任意后续时刻才重读可能被修改的源对象。

### 重名必须延续同一页面的所有权规则

[createViewRefs](../../sdk/src/app-factory/render-commit.ts)已经在写入前拒绝同页同局部名；[typed-data-ref.test.tsx](../../sdk/src/typed-data-ref.test.tsx)覆盖不同显示类型也不能重名、旧 binding 清理不能删除后继。普通 TS 的 `createApp` 同样检查同页重复 Ref。因此若采用 `View.refs`，推荐让 prop 与子组件 hook 进入同一捕获/登记机制，重复名明确拒绝，不能后写覆盖；数组展开后的元素名也属于这一个命名空间。跨 View 的同名 Ref 继续合法。

例如父页 descriptor 和结果面板 hook 都声明 `results`，不能由 layout 或卸载顺序决定 `files.results` 指向哪组数据。诊断应帮助找到两处声明，而不是让作者猜最后哪次注册获胜。这里收敛的是候选新入口必须继承的行为，不新增 owner 或地址语法。

纯 render scope 若提供，只允许普通纯函数，例如 `scope.arrayRef(...)` 与内容构造。需要 `useState/useEffect` 的内容应由框架作为真正的子组件渲染。不能把一个普通回调命名为 render 就声称它获得了组件 hooks 身份；[React Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)也明确区分组件/自定义 hook 与普通嵌套函数。这里引用的是设计约束参考，不是把 React API 当成 Preact 的实现保证。

## 现在的最小做法与后续触发条件

本批用同一 Files 页面复现两种安装结果。将 `useArrayRef('items', …)` 写在返回 `<View>` 的函数顶层时，已安装包通过 `AppRegistry` 返回 `E_OPEN_FAILED`。移到该 View 的 `FilesContent` 后，同样的数据和标记正常发布，Editor 工具可以跨页选中它们。同页重名测试确认第二个 owner 被拒绝、原 owner 保留绑定。实际请求中 `files` 和 `tasks` 各自发布 `items`，两个来源都能正常选取。这是已知问题的受指导修复和工程回归。[页面例子](../../sdk/tests/fixtures/ref-prompt-app.tsx)、[包消费验证](../../sdk/tests/fixtures/ref-prompt-consumer.mjs)、[所有权测试](../../sdk/src/ref-ownership.test.tsx)

负责人在改前、改后的隔离安装中重跑同一练习。两版都在错误位置返回 `E_OPEN_FAILED`，新包的详情明确指出 `useArrayRef`、局部名 `items` 和移动步骤。移动后，原 Files 页的整组与元素都可在 Editor 中使用。独立复跑的 6 项 SDK 所有权测试通过。首次尝试正确率和无指导修复轮数仍需单独取得作者样本。

如果后续比较 scoped child 与 descriptor 原型，用相同任务测量 Agent 首次正确率、修复轮次、组件拆分、prop 传递及重名后的修改成本。两种作者方式应复用捕获、所有权和发布路径。

只有 B 仍不能表达真实的纯内容组合需求时才考虑 C；只有需要跨层传递页面绑定且现有 context/descriptor 无法满足时才考虑 D。长期主义在这里是控制公共 API 的重复承诺，而不是提前实现所有扩展点；绝不能为减少示例行数放宽来源、Schema 或旧绑定校验。

## 必须完整保留的语义

- **原观察。** 地址解析绑定调用的原 Observation；不能静默改取最新值。采用新观察后的旧资格撤销规则不变。
- **两个独立定位。** 顶层 `view_id` 选择执行页面；Ref 前缀选择数据来源页面。同一 App 实例、同一原观察内跨 View 传 Ref 继续合法。
- **完整选择能力。** 单值、完整 ArrayRef、数组元素、多选、有序重复和 optional 缺省均保留；显式空列表与未传参数仍有区别。
- **页面与工具生命周期。** 工具 disabled 后不能继续调用该工具在该页面上的旧激活；同类型其他页面可保留共享工具；关闭和同名重开不恢复旧绑定。新 Ref 作者方式不能绕过这些检查。
- **值与业务边界。** Ref 保持只读 JSON 观察值；目标 Schema 校验继续执行。对象存在性、归属、权限、版本冲突仍由 App 判断。
- **地址分离。** typed 局部展示与全限定调用地址继续分开。任何 helper 都只能减少作者重复拼接，不能改变两种语法。

## 迁移与验收

若 B 进入原型验证，先新增 descriptor 页面样例，与改进诊断后的 scoped child 样例完成相同操作。选定后再按顺序迁移：复用捕获逻辑、接入 View、统一重名与所有者检查、最后补公共导出和文档。不要先批量重写 App。

验收应比较真实调用结果和最终投影：同页两个 Ref 来源冲突、descriptor 与 hook 重名、render 失败、源对象在 layout 中被修改、ArrayRef 缩短和重排、跨 View 选择、整数组与元素、多选顺序/重复、optional 缺省、禁用后重启用、关闭重开。还要验证用户只看到既定显示格式，调用地址解析完全不变。

普通数据构造可在页面函数中完成，现有 hooks 继续遵守 Preact 的组件调用规则。上述原型和对比验收随新增作者 API 的决策推进。

跨议题要保持：06 的真实提交桥统一处理 hooks 与 descriptors；07 的 serializer 保留既定 Ref 展示形式，不统一地址、不错误转义；公共类型归议题 05，不为 `View.refs` 再建一个合同层。开页准入仍暂停，新作者 API 不能顺带改变它。

## 未决问题

1. `View.refs` 是否足以覆盖主要作者需求，还是确有必要再提供纯 render scope？
2. 沿用同页重名拒绝时，诊断如何定位 descriptor 与 hook 的两处声明，而不引入新的注册 owner？
3. descriptor 在文档 AST 中如何表达，才能保留展示语法并避免被当普通文本二次转义？
4. 是否有真实应用需要 `useViewBinding`，足以承担额外生命周期合同？

## 讨论与撤回记录

| 日期与时区 | 记录 |
| --- | --- |
| 2026-11-18 · Asia/Shanghai | 用户认可作用域明确、容易组合的方向，要求任何方案保留 Ref 现有能力。 |
| 2026-11-18 · Asia/Shanghai | 撤回统一 Ref 显示/调用地址的方向；两种地址分离是确定设计。 |
| 2026-11-18 · Asia/Shanghai | 页面按 GUI 页面理解，不绑定固定业务对象；具体 descriptor、scope、binding API 均待讨论。 |
| 2026-11-18 · Asia/Shanghai | 复核 [Review 08](REVIEW-2026-11-18.md#review-08)：采纳先改善诊断和同页重名拒绝的建议；限定作者收益还包含拆分、组合与修复成本。参见 [审查回复](REVIEW-RESPONSE-2026-11-18.md)。`View.refs` 仍为未批准候选。 |
| 2026-11-18 · Asia/Shanghai | 在现有 Provider 检查改进诊断并补充 SDK 范例，保留已验证的注册和提交路径。新增作者入口按同任务对比的证据另行决定。 |

## 文档修订记录

| 修订 | 日期与时区 | 变化与决定状态 |
| --- | --- | --- |
| 0.1 | 2026-11-18 · Asia/Shanghai | 记录作用域摩擦、候选作者方式和必须保留的 Ref 能力；新增 API 尚未决定。 |
| 0.2 | 2026-11-18 · Asia/Shanghai | 统一为 Files/Editor 连续例子，补齐原观察与当前闭包、跨 View 路由、方案成本及触发条件；descriptor 和 `View.refs` 继续标为 proposal，不增加第二 owner。 |
| 0.3 | 2026-11-18 · Asia/Shanghai | 明确可行动诊断、现有重名语义与候选入口的共同 owner；完善作者成本比较，不用单一错误率决定 descriptor 价值。未改现行 API。 |
| 0.4 | 2026-11-18 · Asia/Shanghai | 记录已落地的 hook 诊断、真实包的失败与修复，以及同页和跨页所有权回归。 |
| 0.5 | 2026-11-18 · Asia/Shanghai | 第三批验收通过。保留既有页面注册与清理责任，当前收益限于能定位并完成一次受指导修复。 |
