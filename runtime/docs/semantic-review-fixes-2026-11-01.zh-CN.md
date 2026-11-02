# Semantic 审核修复：最终设计与验证记录

日期：2026-11-01。范围：SDK / Runtime 的 R1–R5 审核修复。

项目所有者已经完成方案评审：R1、R3、R4 的候选方向通过；R5 需补齐访问器输入和字段诊断；R2 原“克隆父 DOM、剪除子 View、分别投影”的方案被否决。本记录采用最终决定：**View 是独立的 Agent 工作页面，AOTUI 不支持嵌套 View。**

## 根因与最终方案

| 项目 | 根因 | 最终处理 |
| --- | --- | --- |
| R1：旧 Context 操作继任 App | 普通 Tool 绑定实例，但生命周期控制仅使用可复用的 appId。 | close / collapse / show 捕获当时的 AppInstance 身份，Desktop 传递原身份，AppManager 在接纳操作、发生副作用之前核对。旧实例操作明确拒绝；新 Context 可操作新实例。open 仍针对已安装的逻辑 App。 |
| R2：嵌套内容重复与越界呈现 | Producer 分别枚举每个 View，却递归转换包含其他 View 的子树；旧候选进一步把嵌套解释成受支持结构。 | SDK 通过现有 View Context 尽早拒绝嵌套，错误说明父子身份及独立声明方式。DOM Producer 在转换和更新缓存前检查并拒绝整份嵌套投影。复用现有失败、健康通知和恢复流程。 |
| R3：重新启用后新绑定仍失败 | Core 的启停版本与注册时冻结的 callable 资格分离，形成两套生命周期。 | 删除 Core setEnabled 和注册 enabled 参数，统一 release / register。SDK enabled 体验保留，底层注销后重新注册。旧绑定失效、新绑定成功必须成对验证。 |
| R4：发布观察执行 getter | live Ref 在严格校验前先被 postMessage 序列化，访问器已变成普通值。 | 发送前复用 copyJson 捕获完整 Draft，限制深度、节点和近似字节量；再次核对投影 epoch 后发送。Host 继续独立执行结构、来源、条目及最终字节预算检查。 |
| R5：无效配置与不准确诊断 | 已删除机制的配置仍可接受；候选检查跳过访问器，而合并读取它；CONFIG_INVALID 传入 errors，但模板读取 reason。 | 删除 bridge / transform 无效配置面。通过描述符检查并合并已支持的配置形状，拒绝访问器，不执行 getter；使用统一 reason 提供准确字段路径，并保留合法配置覆盖与默认行为。 |

R1 并不依赖第二个生产控制入口：Agent 自己关闭、重新打开 App 后，也可能持有旧 Context。默认 Driver 的串行使用和及时 release 可降低发生概率，但不替代 Runtime 对已暴露 Context 的目标身份保证。该修复不增加权限系统或调试模式开关。

## R2 的产品与实现边界

普通 Preact 组件和普通 DOM 元素可以嵌套；View 之间没有父子页面语义。正确方式是分别声明 WorkspaceView、FileDetailView、SearchResultView，并由应用自己的状态控制它们的打开和关闭。

```tsx
function IDEApp() {
  return <>
    <View id="workspace" type="Workspace"><Workspace /></View>
    {openedFile && <View id="file_detail" type="FileDetail">
      <FileDetail file={openedFile} />
    </View>}
  </>;
}
```

SDK 拒绝的是 View 组件嵌套，需验证错误路径不留下部分 View、Tool、Ref 注册。绕过 SDK 直接构造嵌套 DOM 的应用由 DOM Producer 拒绝：非法投影不能部分提交，也不能通过克隆、剪枝、自动重排或忽略子页面继续发布。应用修正结构后按既有 Semantic 健康合同恢复。

纯 Semantic Core 继续接收规范化的独立 View 列表，不引入 DOM 树、权限继承或页面父子关系。R2 旧候选中验证“嵌套能够成功投影”的断言不再作为正式合同保留。

## 验证要求

| 拒绝或失效一侧 | 合法或恢复一侧 |
| --- | --- |
| 旧 Context 的普通 Tool 和生命周期操作不能转移到同 appId 的继任实例 | 新 Context 的普通 Tool 和生命周期操作成功，继任实例未被旧操作修改 |
| SDK 直接嵌套、经普通组件包装的嵌套均明确报错，非法实例和绑定不残留 | 独立兄弟 View、普通组件嵌套、动态打开关闭以及错误后修复正常 |
| 原始 DOM 嵌套导致整份投影拒绝，无缓存污染或部分提交 | 健康变化通知，修复后恢复发布，关闭时资源释放 |
| 已释放的 Core / SDK 绑定拒绝 | 重新注册的最新绑定实际进入 handler |
| Worker 发布访问器与超预算数据被拒绝，getter 次数为零 | 正常 JSON 数据发布，健康恢复并完成关闭 |
| 配置访问器、未知/已删除字段、错误形状或值有准确字段诊断 | 支持的 worker / logger 覆盖、默认值及显式 undefined 行为正常 |

## 本轮验证状态

实现及针对性验证已完成。相对方案评审前保留的候选源码，本轮修改 14 个路径：5 个实现文件、4 个测试文件、5 个文档文件。R1、R3、R4 的既有候选实现保留，并在集成和新包消费中重新验证。

| 验证 | 实际结果 |
| --- | --- |
| Runtime 完整 Vitest | 127 个文件；2,112 项通过，3 项跳过，7 项待办，0 项失败。 |
| SDK 完整 Vitest | 17 个文件；171 项通过，0 项失败。 |
| SDK R2 | 直接/包装组件嵌套拒绝，子组件未运行、View/Ref/Tool 无残留；未捕获的初始渲染失败清理；错误边界恢复；兄弟 View、普通组件及动态开关正常。关闭检查仅调用正式 onClose。 |
| Runtime R2 | 单测检查整份预检、身份诊断、缓存未污染；真实 Worker 检查 raw DOM 绕过、无部分发布、健康通知、恢复及资源释放。 |
| R5 | 原问题先复现后修复；公开 validateRuntimeConfig 也拒绝其读取的访问器字段。六个数值字段不执行 valueOf getter，initialSize 非法时准确指向 initialSize，不误报 maxSize。 |
| 构建 | Driver、Runtime、SDK、IDE、Terminal、Browser、Token Monitor、Planning、Host 全部完成。 |
| 外部安装消费 | 8 个新 tar 在空目录离线安装，使用 ignore-scripts；包目录不是工作区 symlink。797 个安装文件逐个与 tar 比对一致，lock integrity 匹配。 |
| 新包 R1–R5 反例 | 全部通过。R1 仅使用 Agent 生命周期工具关闭/重开，旧控制不能影响继任实例；R2 非法投影全部退出观察、修复后恢复；R3 handler 在原绑定和重新注册后分别进入；R4 getter 为 0；R5 访问器及隐式转换次数为 0。最终关闭 resourcesReleased 为 true。 |
| 严格公共类型 | 新包消费者 skipLibCheck=false 通过，已删除配置和 Core API 的负向类型断言成立。 |
| 既有公开包回归 | 纯 Core 文档示例编译及运行、Runtime/SPI/SDK/IDE 类型、Source/Context/Scope 类型通过；默认真实 Worker 完成 IDE 编辑、实际 LSP 调用和托管关闭。 |

构建环境说明：本机 Token Monitor、Planning 缺少开发依赖；Token Monitor 首次直接构建的 `tsc: command not found` 已保留。隔离目录首次使用 pnpm 又遇到 Corepack 尝试写入缓存的 EPERM；改为 npm 执行同一构建脚本后完成。两应用的最终构建使用当前源码、当前 Runtime/SDK 和已有第三方开发依赖，不是对它们执行全新依赖安装。运行消费者则使用上表中的真实 tar 安装。以上环境失败未改写为原命令成功。

### 可复跑的源码验证

```sh
pnpm -C runtime run build
pnpm -C sdk run build
pnpm -C runtime exec vitest run
pnpm -C sdk exec vitest run
```

需要只核对本批新增行为时，重点查看：

- SDK：`sdk/src/nested-view.test.tsx`、`sdk/src/view-local-tools.test.ts`。
- Runtime：`view-fragment-extractor.r2-boundary.test.ts`、`worker-host.r2-nested-view-boundary.e2e.test.ts`、`worker-host.r4-json-capture.e2e.test.ts`。
- 生命周期与绑定：`runtime/src/kernel/interaction-e2e.test.ts`、`runtime/src/engine/app/manager.interaction.test.ts`、`runtime/src/core/tool/view-owned-tools.ordinary-v2.test.ts`。
- 配置：`runtime/test/spi/config/define-config.test.ts` 与 `config-types.type-test.ts`。

本机验证目录：`/private/tmp/aotui-review2-_l1r6lbt`。其中保留完整日志、失败及最终结果、构建和包清单、源码 SHA-256、消费者验证脚本与事实 JSON；当前首轮安装目录为 `/private/tmp/aotui-review2-consumer-3o4wkca4`。临时目录可能被系统清理，正式合同与回归测试保留在上述仓库文件中。

工作区保留此前代码清理及其他用户改动；本轮没有 Git 暂存、提交或发布。完整 Host 测试套件、真实模型和实际 Electron 窗口没有在本轮执行，不能据此称为通过。

MEM-01 保持独立；本批不重开或改写此前内存门槛失败的结论。
