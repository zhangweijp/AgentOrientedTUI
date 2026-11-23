# @aotui/agent-driver-v2

多源消息聚合器，用于整合 AOTUI Runtime 和 Host 的消息和工具，发送给 LLM。

## 特性

- **多源聚合**: 支持多个 DrivenSource（AOTUI、Host 等）
- **时间戳排序**: 自动按时间戳排序来自不同源的消息
- **ToolCall 路由**: 根据 Tool 来源自动路由执行
- **类型安全**: 基于 Vercel AI SDK v6，全程 TypeScript
- **Provider 支持**: 支持 OpenAI、Anthropic、Google、xAI 等主流 LLM Provider

## 架构

```
┌─────────────────────────────────────┐
│      AgentDriver V2                 │
│                                     │
│  ┌───────────────────────────────┐ │
│  │  Messages (sorted)            │ │
│  │  - AOTUI Snapshots            │ │
│  │  - Host Messages              │ │
│  └───────────────────────────────┘ │
│                                     │
│  ┌───────────────────────────────┐ │
│  │  Tools                        │ │
│  │  - AOTUI Tools                │ │
│  │  - (Future: Other Tools)      │ │
│  └───────────────────────────────┘ │
│                                     │
│  ┌───────────────────────────────┐ │
│  │  ToolCall Router              │ │
│  │  → Find DrivenSource          │ │
│  │  → Execute Tool               │ │
│  └───────────────────────────────┘ │
└─────────────────────────────────────┘
           ↓
      LLM (Vercel AI SDK)
```

## API

### 唯一 getContext 接口

```typescript
import type { ContextDrivenSource, DrivenSourceContext } from '@aotui/agent-driver-v2';

interface Source extends ContextDrivenSource {
  readonly name: string;
  getContext(): Promise<DrivenSourceContext>;
  onUpdate(callback: () => void): () => void;
}

// DrivenSourceContext 返回：
// messages: MessageWithTimestamp[]
// tools: Record<string, Tool>
// executeTool?: (name, args, toolCallId) => Promise<ToolResult | undefined>
// release?: () => void | Promise<void>
```

Driver 每轮按 Source 顺序调用一次 getContext，用返回的消息、工具和执行器组装本轮输入与路由。同名工具由后一个 Source 覆盖。执行器以 Context 作为 this 调用，不会回读 Source 的执行方法。Source 如需使用自身状态，应在捕获时建立相应闭包。

模型返回后，Driver 串行派发工具，并在每次调用前检查 stop / Source 禁用状态。无执行器与执行器返回 undefined 仍有不同错误。LLMClient 向模型 SDK 传递的浅层工具定义会移除 execute；Schema、模型元数据和其他 SDK 回调保留，原工具不被修改。流式与非流式均采用这一边界。

Context 的持有期覆盖模型等待和全部真实工具工作，finally 逆序 release；一个 release 失败仍继续清理其余 Context。无保留资源的 Source 无需空 release，无工具 Source 无需假执行器。getContext 抛错会中止当前轮，后续 Source 不再捕获，之前的 Context 仍释放。可选来源若要降级，应自行记录真实失败并返回完整空 Context，不能让 Driver 通用吞错。当前五个 Host 来源在自己的边界保持原降级策略；Runtime 状态捕获失败仍中止本轮。

MCP 的 Context 固定原 Tool 执行函数及接收者，执行前复核当前 Source/工具/服务器控制。Host compaction 固定捕获的 topicId，切换后旧调用拒绝，不转投新 topic。Skill 固定捕获的 catalog 实例；IM 继续共享历史加载 Promise。工具结果不代表可自动重试，unknown / accepted 的既有提示保持。Host/IM 接入负责保存新结果后发出现有更新信号，最终 assistant 不自行触发下一轮。

### 实现位置

- 公共合同：agent-driver-v2/src/core/interfaces.ts
- SemanticAOTUIDrivenSource：agent-driver-adapter/src/semantic-aotui-driven-source.ts
- Host / SystemPrompt：host/src/adapters/
- MCP / Skill / IM：host/src/mcp/、host/src/skills/、host/src/im/

## 使用示例

```typescript
import { AgentDriverV2, type ContextDrivenSource } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

// desktop、kernel 由宿主创建；会话消息与通知也由宿主管理。
const conversation: ContextDrivenSource = {
  name: 'conversation',
  async getContext() {
    return {
      messages: [{ role: 'user', content: 'Inspect the current application.', timestamp: 1, region: 'session' }],
      tools: {},
    };
  },
  onUpdate() { return () => {}; },
};
const driver = new AgentDriverV2({
  sources: [new SemanticAOTUIDrivenSource(desktop, kernel), conversation],
  llm: { provider: { id: 'openai' }, model: 'gpt-4' },
  onAssistantMessage: message => console.log(message),
  onToolResult: message => console.log(message),
});
await driver.trigger();
// 宿主结束会话时先等工具结果保存，再释放订阅。
await driver.closeToolTurn();
driver.dispose();
```

`closeToolTurn()` 停止调度，并等待 `onToolResult` 保存已公布的整组调用结果。已返回的结果按原样交付，未派发的调用报告未执行。仍等待外部执行器时报告未知结果。若来源能在取消后及时交回原结果或收据，可在本轮 Context 的 `toolsSettlingOnAbort` 声明对应工具。异步保存应从 `onToolResult` 返回保存 Promise。

### 消息格式

`MessageWithTimestamp` 在 AI SDK 的 `ModelMessage` 上增加毫秒 `timestamp` 和可选 `region`。工具调用参数放在 `input`，工具消息使用 `ToolResultPart.output`，例如 `{ type: 'json', value: { saved: true } }`。普通 assistant 字符串按原文发送。

### LLM 配置

`LLMConfig` 要求显式提供 `provider.id` 和非空的 `model`。`model` 是供应商实际接受的 ID，路径、冒号后缀以及恰好与 Provider 同名的开头都会原样发送。宿主通过 `inputBudget` 收到同一对 `providerId` 和 `modelId`。

```typescript
import { createLanguageModel, type LLMConfig } from '@aotui/agent-driver-v2';

const config: LLMConfig = {
  provider: { id: 'openrouter' },
  model: 'z-ai/glm-4.5-air:free',
};
const model = createLanguageModel(config);
```

OpenAI 的官方地址走 Responses API，明确配置的兼容地址走 Chat Completions。Anthropic、Google、DeepSeek、xAI 和 OpenRouter 各自按选定的 Provider 配置请求。通用 OpenAI-compatible 服务需要自己的 `provider.id` 和 `provider.baseURL`。

`AgentDriverV2` 使用通用 Chat Completions 或内置 DeepSeek 时，带工具调用的流可以用显式 `finish_reason` 或一条完整的 SSE 事件 `data: [DONE]` 表示结束。若工具参数已经收全，连接却在两个结束信号都缺失时关闭，Driver 会通过 `onRunError` 报告本轮中断，避免分派这次调用。

`apiKey` 可以直接提供，或使用对应 Provider 的环境变量。OpenAI、Anthropic、Google、DeepSeek、xAI 和 OpenRouter 分别读取 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_API_KEY`（也支持 `GOOGLE_GENERATIVE_AI_API_KEY`）、`DEEPSEEK_API_KEY`、`XAI_API_KEY` 和 `OPENROUTER_API_KEY`。通用 Provider 使用其大写 ID 对应的 `<ID>_API_KEY`。

OpenAI 与 DeepSeek 可设 `provider.toolSchemaMode: 'strict'`。默认 `'non-strict'`，Driver 在两种模式都显式发送实际的 `strict` 值。DeepSeek strict 需要 `baseURL` 以 `/beta` 结尾。Agentina 可在 `config.json` 的 `toolSchemaModes` 按实际路由设置，例如 `{ "deepseek:deepseek-chat@https://api.deepseek.com/beta": "strict" }`，默认地址也可用 `provider:model` 作键。自定义地址只识别带地址的键。Provider 端的兼容性随所用服务和模型而定。 [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling#strict-mode) · [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta)

Driver 将当前 `ProviderToolSchemaPolicy` 交给 `getContext(policy?)`，Source 可在预算、采用和发送之前用它检查实际原生 Schema。独立宿主也可调用 `createProviderToolSchemaPolicy(config)`。不兼容的可选 Source 工具会带原因退出请求，无法发送必需工具时报 `MODEL_TOOL_SCHEMA_UNSUPPORTED`。整次请求被服务拒绝时，原错误交给 `onRunError`。部分 Google SDK 版本会把 Schema 转换成 OpenAPI `parameters`，Driver 会根据本地编码判断，该编码丢失的约束会在采用前报告。

OpenAI strict 按每个工具单独检查整份 Schema。各处 `enum` 合计最多 1000 项，嵌套最多 10 层。超过 250 项的字符串枚举还检查 15000 字符的总长度。诊断包含对应路径、使用量和上限。 [OpenAI Schema 上限](https://developers.openai.com/api/docs/guides/structured-outputs#limitations-on-enum-size)

Agentina 的 Topic 和 Agent 用 `provider:model` 选择模型。激活配置分别保存 Provider 和原始模型 ID。自定义 Provider ID 由 Host 解析为当前设置中的协议、地址和凭据。

### 模型用量

Driver 的 `onLLMUsage(usage)` 接收 AI SDK 的 `LanguageModelUsage`。输入和输出分别从 `inputTokens` 和 `outputTokens` 读取。总量使用 `totalTokens`，缓存与推理明细分别从 `inputTokenDetails` 和 `outputTokenDetails` 读取。同一次响应最多通知一次。提供方明确报告的零会透传。响应既无归一用量也无原始对象时跳过通知，只有归一用量时省略 `raw`。发送前的上下文预算仍由独立的 `inputBudget` 处理。

- 通用 Chat Completions（含 OpenAI 兼容地址）从同一次流的用量块保留完整 JSON，包括嵌套扩展。DeepSeek 使用其适配器提供的原始用量对象。
- OpenAI 官方与 xAI Responses 从 `response.completed` 或 `response.incomplete` 终止事件读取原始 `response.usage`，保留服务报告的总量、缓存明细及扩展。Google GenerateContent 从同一条流取最近一次报告的 `usageMetadata`，保留按模态列出的输入与候选输出明细。后续块缺报时仍使用前一份对象。归一计数继续由 AI SDK 提供。
- Anthropic 合并 `message_start` 和 `message_delta` 的用量。OpenRouter Chat 和 Completion 返回其适配器保留的 `usage`，包括已交付的成本和明细。

产品 Host 通过 `HostManagerV2.onModelUsage(listener)` 向宿主进程交付 `{ kind, sessionId, providerId, modelId, usage }`。对话题，`kind` 为 `topic`，`sessionId` 为话题 ID。对 IM，`kind` 为 `im`，`sessionId` 为 IM 会话键。调用订阅返回的函数即可取消。用量订阅独立于消息保存、IM 发送和 App 投影。

## AOTUI Runtime integration

Hosts connecting this Driver to AOTUI Runtime use the separate `@aotui/agent-driver-adapter` package. It provides `SemanticAOTUIDrivenSource` and requires matching Runtime and Driver peers. The Driver itself does not depend on Runtime. See the adapter README for the package versions.
