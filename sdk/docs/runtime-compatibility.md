# 使用匹配的 SDK 与 Runtime 包

当前推荐作者入口是 [SDK 指南](view-type-tools.md)：Preact 用 `createTUIApp` + `AppTools`；普通 TypeScript 在既有 Producer 中用 `createToolBindings`。两者复用同一 Tool 声明和 Runtime 调用合同。App 模块的 default 是 `createTUIApp` 返回的托管工厂，Host 不搜索旧 factory 字段或命名导出。

## 当前匹配组合

| 包 | 当前源码版本 | 用途 |
| --- | --- | --- |
| `@aotui/runtime` | `7.0.0-srt.1` | Core、Node Host、Worker 与中立呈现 |
| `@aotui/sdk` | `0.8.0-srt.1` | Preact App 和普通 TS 的声明／绑定 helper |
| `@aotui/agent-driver-adapter` | `0.4.0-srt.1` | 使用本项目 Driver 的 Host 适配 |
| `@aotui/agent-driver-v2` | `0.3.0` | 可选的模型驱动器 |

这是当前共享源码采用的组合；不表示已经在 registry 发布，也不推广到版本相近的旧包。版本以各 package.json 为源，tar 身份和实际消费者验证共同确认产物。SDK 精确依赖 Runtime；Adapter 的 Runtime 和 Driver 是必需 peer，使用其他 Agent 系统不必安装这两个 Driver 包。Runtime／SDK 生产依赖不含具体 Driver。

## 当前协议与拒绝边界

下表供 Runtime／宿主集成者定位当前合同。App 作者继续使用上述 SDK 入口，不手写这些标记。包版本、工厂、端口、Snapshot、调用和持久化各自演进，没有统一的协议大版本；源码文件或类型名里的 V2／V3 也不能替代实际字段。

| 合同 | 当前身份与生产／消费位置 | 支持与拒绝边界 |
| --- | --- | --- |
| 托管 App 工厂 | SDK `createTUIApp` 提供 `toolAuthoringProtocol: 'view-type-tools-v4'`，Runtime 的 `hasViewTypeToolAuthoringProtocol` 校验 | Registry 从生成的 aoapp.json 读取该标记而不执行 App；Worker 的模块 default 必须是托管对象工厂。`isTUIAppFactory` 先检查形状、持久化及生命周期声明，后续才检查工具标记；缺失、旧值或 accessor 工具标记产生 `APP_AUTHORING_PROTOCOL_UNSUPPORTED`，不执行它的 getter 或初始化回调。形状不合法按原导出／INIT 错误路径拒绝。 |
| App Tool 注册端口 | Runtime `IAppTypeToolPort.protocol: 'view-type-tools-v4'`，SDK `createToolBindings` 消费 | 端口标识与工厂声明共用 Runtime SPI 的 `VIEW_TYPE_TOOL_PROTOCOL`，承担不同检查职责，不能互相替代。端口标识或注册函数无效时为 `TOOL_BINDING_PORT_INVALID`；仍须有真实注册、活跃 ViewType 和绑定。 |
| 当前状态 Snapshot | Core 的 `PreparedAppSnapshotDraftV3`／`AppSnapshotV3` 使用 `schemaVersion: 3`；DOM Producer 或普通 TS Producer 提交，Core `v3-validator` 接收 | 内容格式支持 `markdown-v1`／`semantic-v1`。Runtime 自己生成并请求 `app-snapshot/v3`，Worker 在导入 App 前要求该能力，Host 在 OPEN 前要求 ACK；缺失为 `WORKER_SNAPSHOT_UNSUPPORTED`，未知版本能力为 `WORKER_CAPABILITY_UNSUPPORTED`。其他实际 schemaVersion 仍由数据边界拒绝为 `SNAPSHOT_INVALID`；握手不代替身份、序列、Ref owner、Tool activation 及预算检查。 |
| Host 交互选择 | SPI `SEMANTIC_INTERACTION_MODES` 只含 `view-type-parameters-v1`；Host `captureInteractionModes` 捕获配置 | 默认启用该模式；显式空数组关闭 Tool 执行协商，仍协商当前 Snapshot。重复、未知值及 accessor 配置为 `INTERACTION_MODES_INVALID`，不会改选旧模式。 |
| Worker Tool IPC | `PARAMETERS_V4_CAPABILITY = 'view-tool-parameters-invoke/v4'`；`VIEW_TOOL_INVOKE_V4`／`VIEW_TOOL_INVOKE_V4_RESPONSE` 的 `argumentMode` 为 `view-type-parameters-v1` | 启用工具时 Host INIT 请求此能力，Worker 明确返回 acceptedCapabilities；Host 要求全部请求的能力被确认，缺少调用能力为 `WORKER_CAPABILITY_UNAVAILABLE`。双方仍独立校验完整调用消息、success 判别的 JSON 结果、身份与预算；不尝试旧 RPC。 |
| 参数与 Ref profile | Core `ordinaryParameterProfile`／`compileOrdinaryProfile` 处理 `x-aotui-parameter-contract`；当前 ViewType 路径使用 `view-type-parameters-v1`，SDK `refParam` 生成 Ref Schema | 普通值和 Ref 使用同一路径。Ref 展示用类型提示与局部名，调用用 `view_id.local_ref`；来源由 Observation 解析。未知 profile 不被编译成可信合同，不靠字符串前缀授予 Ref 类型。 |
| App 生命周期 | SDK 声明 `appLifecycleSupport: 'app-lifecycle-v2'`；Runtime 端口／清理报告用该 protocol，INIT offer／ACK 另带 `version: 2` 和同一 instanceId | Worker 校验 offer，Host `captureAppLifecycleAck` 校验 ACK；缺失、旧值、错误版本或实例不能建立托管生命周期。Host 的 ACK 失败为 `APP_LIFECYCLE_NEGOTIATION_FAILED`；清理报告仍另行校验，不把 ACK 当作已关闭。 |
| 实例持久化与传输 | SDK 声明 `persistenceSupport: 'state-session-v1'`；Runtime 的 `STATE_SESSION_PROTOCOL` 标识 offer／ACK、App 端口和报告。offer／ACK 与 `STATE_STORAGE_REQUEST`／`STATE_STORAGE_RESPONSE` 的传输版本为 `1` | Worker `capturePersistenceOffer` 与 Host `capturePersistenceAck` 分别检查版本、实例及预算；Host ACK 失败为 `PERSISTENCE_NEGOTIATION_FAILED`。请求／响应还核对 sequence、action、地址和结果，不能用生命周期 ACK 代替持久化结算。 |
| 持久化记录编码 | Core `encodeStateRecord`／`decodeStateRecord` 的 JSON 外壳为 `{ version: 1, updatedAt, value }` | 记录格式与实例传输是独立合同；无版本的裸业务 JSON 或其他记录版本为 `UNSUPPORTED_FORMAT`。业务自己的 version 字段可位于 value 内，不充当外壳版本。 |

当前 Worker 握手会将退役的 `view-tool-ordinary-invoke/v2`、`view-tool-ref-invoke/v2` 拒绝为 `WORKER_PROTOCOL_V3_REQUIRED`（保留的既有错误码名称）；`view-tool-ref-invoke/v3` 和其他未知能力为 `WORKER_CAPABILITY_UNSUPPORTED`；不合法的能力列表为 `WORKER_CAPABILITY_INVALID`。这些拒绝不代表所有名为 ordinary-v2 的代码都已退出：可信 invoker 的 `ordinary-v2` ABI、纯 Core 的同名执行模式及 `ordinary-params-v1` 普通参数 profile 仍有受支持消费者，不是旧 Worker RPC 的 fallback。

这些检查发生在各自入口。旧工厂、缺少必要 offer／ACK、未知能力或不匹配的调用身份不能靠“包版本看起来相近”通过。Worker INIT／OPEN 的失败仍按原阶段和诊断合同报告，不将不同错误统一改写成一个兼容错误。

## 从本仓库构建与打包

在项目根目录使用已安装、与锁文件一致的依赖：

```sh
pnpm -C runtime run build
pnpm -C sdk run build
# 使用本项目 Driver 的 Host 再构建：
pnpm -C agent-driver-v2 run build
pnpm -C agent-driver-adapter run build
mkdir -p /tmp/aotui-author-artifacts
pnpm -C runtime pack --pack-destination /tmp/aotui-author-artifacts
pnpm -C sdk pack --pack-destination /tmp/aotui-author-artifacts
pnpm -C agent-driver-v2 pack --pack-destination /tmp/aotui-author-artifacts
pnpm -C agent-driver-adapter pack --pack-destination /tmp/aotui-author-artifacts
```

普通包消费者应在独立目录安装这些 tar，用包名导入，不用源码 alias 或工作区软链。下面是仅 SDK／Runtime 的本地 pnpm 消费者 package.json（tar 路径按实际位置修改）；override 保证 SDK 使用同一 Runtime tar：

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@aotui/runtime": "file:/tmp/aotui-author-artifacts/aotui-runtime-7.0.0-srt.1.tgz",
    "@aotui/sdk": "file:/tmp/aotui-author-artifacts/aotui-sdk-0.8.0-srt.1.tgz",
    "preact": "10.29.1",
    "typebox": "1.4.3"
  },
  "pnpm": {
    "overrides": {
      "@aotui/runtime": "file:/tmp/aotui-author-artifacts/aotui-runtime-7.0.0-srt.1.tgz"
    }
  }
}
```

在该目录运行 `pnpm install`。需要标准 Source 时，再把上表 Adapter 和 Driver 的实际 tar 加入 dependencies 和 overrides。TypeScript 验证另安装 `typescript@7.0.2`、`@types/node@20`；Node Worker 运行使用 Node 24。不要用同版本号替换成另一份未知 tar。

完整文件 App、Ref App、普通 TS controller 都随 SDK 的 `docs/examples/` 打包。复用仓库现有验证入口，传入已安装四个匹配包的消费者绝对路径和结果路径：

```sh
node sdk/tests/srt01-m4/verify-docs.mjs /absolute/consumer /tmp/aotui-author-check.json
```

该入口严格编译安装包中的完整示例，运行实际 Worker／Scope／Source 和普通 TS 的公开 Core 接线，验证打开、更新、关闭及释放。目录名是历史测试定位，当前推荐作者无需理解旧阶段。

## 框架与 App 各自负责什么

SDK 从 Runtime SPI 的唯一常量提供 `view-type-tools-v4` 工厂标记、实例持久化和 `app-lifecycle-v2` 支持；不手写协议 opt-in。没有外部资源时不必调用 `useAppLifecycle`，有资源才提供同步 stop 和可等待 close。`usePersistentState` 管理实例序列化状态；Host 拥有底层存储及真实 flush／释放。

Host／Worker 的当前执行 mode 是 `view-type-parameters-v1`。同一个 Tool 可接收普通值和 Ref：Runtime 从采用的 Observation 展开 Ref 后，将同一 effectiveInput 交给授权与 handler。类型、来源、activation、参数、结果读取及资源预算仍分别校验。SDK 的绑定 enabled 和 Tool 可见性不授予业务权限；App 保留当前业务状态和权限检查。

Host 创建 Scope，App 不创建 Scope。观察采用与释放见 [Ref 指南](readonly-ref-v2.md)，底层 Host 装配见 [公共 App 交互](../../runtime/docs/runtime-app-interaction.md)，退出接口替换见 [迁移指南](migration.md)。退役作者入口和 Worker RPC 无 fallback；上表列明的纯 Core 与可信 invoker 合同继续保留。

## 严格类型检查的边界

纯 Core 可以在 ES2022-only、`types: []`、`strict`、`skipLibCheck: false` 下使用。SDK 作者入口使用 Preact／DOM ambient；`@aotui/sdk/tools` 的运行时图不加载 Preact、DOM 或 Worker，但包安装仍有 Preact peer，SPI 声明仍需要 DOM 类型。

完整 Driver 的严格类型问题已由 SRT-06 的精确临时补丁解决：AI 6.0.326、provider-utils 4.0.65 和 Driver 随包的 `patches/provider-utils-4.0.65.patch`。实际 Host 已配置同一补丁与 ai@6 override，并对齐本地链接 Driver 的 Zod 3.25.76 peer 图；不把其他 provider-utils major 强制为 4。源码 Host 的严格项目保持 strict/exactOptionalPropertyTypes:true、skipLibCheck:false。

Pnpm 不继承依赖包自身的 patchedDependencies。集成 Driver 的外部消费者须按 Driver 随包 `STRICT_TYPES.md`，先把补丁复制到自身版本控制目录，再声明精确 AI/utils、所用 Zod 和 @types/json-schema，并正常安装、提交自己的锁文件。只安装 Runtime/SDK 的作者不需要 AI 类型补丁。既有失败日志是修复前历史事实，不能继续作为当前工具链仍阻断的说明；临时补丁也不是正式上游已经修复或任意依赖组合都兼容的承诺。
