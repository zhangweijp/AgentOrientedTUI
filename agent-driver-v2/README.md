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

// DrivenSource 是 ContextDrivenSource 的同形别名。
// DrivenSourceContext 返回：
// messages: MessageWithTimestamp[]
// tools: Record<string, Tool>
// executeTool?: (name, args, toolCallId) => Promise<ToolResult | undefined>
// release?: () => void | Promise<void>
```

Driver 每轮按 Source 顺序调用一次 getContext，用返回的消息、工具和执行器组装本轮输入与路由。同名工具由后一个 Source 覆盖；getToolSource 保留该轮来源查询。执行器以 Context 作为 this 调用，不会回读 Source 的执行方法。Source 如需使用自身状态，应在捕获时建立相应闭包。

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
// 宿主结束会话时停止调度、等待其实际工作并 dispose 订阅。
```

### 从 split API 迁移

IDrivenSource 及其导出已经退出。把原 getMessages/getTools 读取合并为 getContext，在这一捕获中确定执行目标，并返回该轮 executeTool；删除 Source 的旧公共 getMessages/getTools/executeTool，不保留兼容包装。不要把返回的执行器重新指向下一轮可变缓存。只返回消息或工具的旧对象不再满足 Source 类型。

保留现有消息格式、timestamp/region、tool-call/result 读取及 compaction 行为；本次不迁移历史消息格式。需要降级的来源在自身捕获边界一次处理全部消息和工具，失败时不能返回半份状态；下一次显式捕获可重试。更新用已有 onUpdate 通知，不能为迁移新增自动业务重试。

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

### 模型路由迁移

旧的 `model: 'openai:gpt-4'` 应迁移为 `provider: { id: 'openai' }, model: 'gpt-4'`。仅填写 `model: 'gpt-4'` 的调用需要补上实际 Provider。JavaScript 和 TypeScript 使用同一合同。直接构建模型的调用使用 `createLanguageModel(config)`。

Desktop Host 的 Topic、Agent 和外部模型目录值由 `LLMConfigService` 解析成上述配置。自定义 Provider 的 Host ID 由设置解析为所选协议、地址和 Key。

## 下一步

- [x] 实现完整的 LLM ReAct 循环 (streamText)
- [ ] ToolCall 超时配置尚无实际执行机制，本轮未实现
- [x] 添加单元测试
- [x] 实现 SemanticAOTUIDrivenSource (在 runtime 中)
- [x] 实现 HostDrivenSource (在 host 中)
- [x] 移除 ModelRegistry 依赖（迁移到 Host 主进程）


## AOTUI Runtime integration

Hosts connecting this Driver to AOTUI Runtime use the separate `@aotui/agent-driver-adapter` package. It provides `SemanticAOTUIDrivenSource` and requires matching Runtime and Driver peers. The Driver itself does not depend on Runtime. The SRT-06 candidate package versions are unpublished; see the adapter README for the exact pairing.
