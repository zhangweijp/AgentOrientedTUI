# SDK 与 Runtime 集成合同

SDK 管理 Preact 组件、View、数据 Ref 和 View-local Tool 声明；Runtime 管理实例身份、来源绑定、能力确认、调用与自身资源。应用模块的 `default` 必须是唯一托管组件工厂，通常直接写成 `export default createTUIApp({ app_name, component })`。Host 只从 `module.default` 加载工厂，不搜索命名导出或旧的 `factory` 字段。

## 应用工厂与生命周期

`createTUIApp` 返回工厂所需的 `displayName`、`kernelConfig.appName` 和 `initializeComponent`，并声明实例持久化与 `app-lifecycle-v2` 支持。SDK 工厂总是提供生命周期合同，不需实验 opt-in。应用没有外部资源时无需调用 `useAppLifecycle`；有资源时按需提供同步 `stop`、可等待的 `close`，二者各自可选。Runtime 未确认所需的托管能力时会拒绝初始化，不改走对象 App、callable factory 或旧生命周期。

`usePersistentState` 是默认的实例状态 Hook。需要应用自行管理绑定与恢复的高级流程时，`useAppRuntimeContext()` 也会返回当前实例的完整 `AppStatePersistence` 客户端口，包含 `captureValue`、`bind` 和 `flush`；`bind()` 返回的 binding 负责该应用绑定的恢复确认、更新、清理和释放。它只管理当前 App 实例的序列化状态，不是 Host 文件系统或 storage adapter。Host 仍负责底层持久化资源以及 close 时的真实 flush 与释放。

## 两种 Tool 调用合同

`useViewTypeTool(name, options, handler, config?)` 是唯一 authoring Hook。普通参数（包括空参数及普通只读 Tool）使用 `ordinary-v2`；一个必填顶层同 View 的只读对象 Ref 与普通字段组合使用 `snapshot-value-v2`。Ref 声明保留 `refSource: 'snapshot-value-v1'` 作为来源元数据，这不是 V1 transport。`isMutating: false` 描述 Tool 行为，不能替代 Host 授权。

Host 在应用注册时设置 `interactionModes`。缺省时完整支持 `ordinary-v2` 与 `snapshot-value-v2`；显式子集按原样使用，`[]` 关闭两种模式，未知值拒绝。SDK 不因 Worker 缺少相应确认而静默降级。Tool 的公开名称、Schema、`targetSelector` 和当前 View 捕获目标保持同一声明来源；执行时 Runtime/Worker 仍校验观察来源、实例代次、绑定、参数合同和当前授权。

可信 Host 使用 Runtime 的 `createAppScope(desktopId, appId, policy)` 为已注册应用创建受信交互 Scope。Scope 负责具体 Binding 选择、`authorize` 策略和 receipt 读取资格；SDK App 只声明 Tool 与 View，不创建 Scope，也不能用 `enabled` 或 Schema 取代授权。关闭、重初始化或旧 View 失效会撤销对应 Scope/Binding；旧观察不能被重新指向继任实例。

## 交付与兼容

使用同一交付的 Runtime、SDK 和 Host 产物。包版本号或源码 alias 不能证明 Worker 已确认所需合同；验证应针对实际安装的 SDK/Runtime 包和 Host 注册配置。旧 SDK/Worker 组合不会因能 import 新声明而自动获得 V2 执行能力。

SDK export allowlist 和应用作者可调用的能力见 [API 状态](api-status.md)。具体参数语法见 [ordinary-v2](ordinary-v2.md) 和 [readonly-ref-v2](readonly-ref-v2.md)，清理行为见 [tool-lifecycle](tool-lifecycle.md)，实例保存见 [persistence](persistence.md)。
