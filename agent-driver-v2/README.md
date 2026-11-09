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
  llm: { model: 'openai:gpt-4', apiKey: process.env.OPENAI_API_KEY },
  onAssistantMessage: message => console.log(message),
  onToolResult: message => console.log(message),
});
await driver.trigger();
// 宿主结束会话时停止调度、等待其实际工作并 dispose 订阅。
```

### 从 split API 迁移

IDrivenSource 及其导出已经退出。把原 getMessages/getTools 读取合并为 getContext，在这一捕获中确定执行目标，并返回该轮 executeTool；删除 Source 的旧公共 getMessages/getTools/executeTool，不保留兼容包装。不要把返回的执行器重新指向下一轮可变缓存。只返回消息或工具的旧对象不再满足 Source 类型。

保留现有消息格式、timestamp/region、tool-call/result 读取及 compaction 行为；本次不迁移历史消息格式。需要降级的来源在自身捕获边界一次处理全部消息和工具，失败时不能返回半份状态；下一次显式捕获可重试。更新用已有 onUpdate 通知，不能为迁移新增自动业务重试。

### LLM 配置格式

AgentDriverV2 支持灵活的 LLM 配置格式：

```typescript
// 格式 1: 简单格式（自动推断 Provider）
const config: LLMConfig = {
  model: 'gpt-4',  // 自动推断为 openai
};

// 格式 2: 显式指定 Provider
const config: LLMConfig = {
  model: 'openai:gpt-4',  // 使用冒号分隔
};

// 格式 3: 自定义 Provider 配置
const config: LLMConfig = {
  model: 'anthropic:claude-3-5-sonnet-20241022',
  provider: {
    id: 'anthropic',
    baseURL: 'https://api.anthropic.com',  // 可选
  },
  apiKey: process.env.ANTHROPIC_API_KEY,
  temperature: 0.7,
  maxSteps: 10,
};

// 格式 4: 使用 OpenRouter
const config: LLMConfig = {
  model: 'meta-llama/llama-4-scout-17b-16e-instruct',
  provider: {
    id: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  apiKey: process.env.OPENROUTER_API_KEY,
};
```

### 支持的 Provider

- **OpenAI**: `openai:gpt-4`, `openai:gpt-4-turbo`
- **Anthropic**: `anthropic:claude-3-5-sonnet-20241022`
- **Google**: `google:gemini-2.5-flash`
- **xAI**: `xai:grok-beta`
- **自定义**: 任何 OpenAI 兼容的 API（通过 `provider.baseURL` 配置）

## 迁移指南

### 从旧版本迁移

如果你之前使用 ModelRegistry，现在需要改为直接传递完整的 LLMConfig：

**之前（使用 ModelRegistry）：**

```typescript
import { AgentDriverV2, ModelRegistry } from '@aotui/agent-driver-v2';

const registry = new ModelRegistry();
const driver = new AgentDriverV2({
  sources: [...],
  llm: {
    model: 'gpt-4',
  },
  // ModelRegistry 会自动注入
});
```

**现在（直接配置）：**

```typescript
import { AgentDriverV2 } from '@aotui/agent-driver-v2';

const driver = new AgentDriverV2({
  sources: [...],
  llm: {
    model: 'openai:gpt-4',  // 需要包含 provider 前缀
    apiKey: process.env.OPENAI_API_KEY,  // 需要显式提供 API Key
    temperature: 0.7,
    maxSteps: 10,
  },
});
```

**关键变化：**

1. **ModelRegistry 已移除**: 不再从 `@aotui/agent-driver-v2` 导出
2. **完整配置**: LLMConfig 需要包含所有必要字段（model, apiKey, provider 等）
3. **Model 格式**: 推荐使用 `providerId:modelId` 格式（如 `openai:gpt-4`）
4. **API Key**: 需要显式提供或通过环境变量设置

### 在 Host 应用中使用

如果你在 Host 应用中使用 AgentDriverV2，应该通过 LLMConfigService 获取配置：

```typescript
import { HostManagerV2 } from '@aotui/host';

const hostManager = new HostManagerV2(topicId, modelRegistry);

// LLMConfigService 会自动从 ModelRegistry 获取配置
// 并转换为完整的 LLMConfig
await hostManager.initAgentDriver(desktop, kernel, desktopManager);
```

## 环境变量

AgentDriverV2 支持从环境变量自动读取 API Key：

- `OPENAI_API_KEY`: OpenAI API Key
- `ANTHROPIC_API_KEY`: Anthropic API Key
- `GOOGLE_API_KEY`: Google AI API Key
- `XAI_API_KEY`: xAI API Key

如果在 LLMConfig 中没有提供 `apiKey`，会自动从对应的环境变量读取。

## 下一步

- [x] 实现完整的 LLM ReAct 循环 (streamText)
- [ ] ToolCall 超时配置尚无实际执行机制，本轮未实现
- [x] 添加单元测试
- [x] 实现 SemanticAOTUIDrivenSource (在 runtime 中)
- [x] 实现 HostDrivenSource (在 host 中)
- [x] 移除 ModelRegistry 依赖（迁移到 Host 主进程）


## AOTUI Runtime integration

Hosts connecting this Driver to AOTUI Runtime use the separate `@aotui/agent-driver-adapter` package. It provides `SemanticAOTUIDrivenSource` and requires matching Runtime and Driver peers. The Driver itself does not depend on Runtime. The SRT-06 candidate package versions are unpublished; see the adapter README for the exact pairing.
