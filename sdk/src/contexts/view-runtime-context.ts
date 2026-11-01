/**
 * AOTUI SDK - View Runtime Context
 *
 * Runtime context for a mounted View.
 *
 * @module @aotui/sdk/contexts/view-runtime-context
 */
import { createContext } from "preact";
import type { IViewMeta, IRefRegistry, LLMOutputEvent, LLMOutputListener,
  ViewToolDefinition, ViewToolRegistrationOptions } from "@aotui/runtime/spi";

// ═══════════════════════════════════════════════════════════════
//  LLM Output Channel Context (RFC-011)
// ═══════════════════════════════════════════════════════════════

/**
 * SDK 侧的 LLM 文本通道接口
 * 
 * View 通过此接口订阅 LLM 文本输出。
 */
interface ILLMOutputChannelContext {
  /** 
   * 订阅 LLM 文本事件
   * @returns 取消订阅函数
   */
  subscribe(listener: LLMOutputListener): () => void;

  /** 获取历史消息 */
  getHistory(): LLMOutputEvent[];
}

// ═══════════════════════════════════════════════════════════════
//  统一 Context 值接口
// ═══════════════════════════════════════════════════════════════

/**
 * 统一的 View 运行时上下文值
 *
 * 设计原则:
 * 1. 所有字段使用 readonly 防止意外修改
 * 2. 公共 API (meta) 与内部 API 清晰分离
 * 3. Runtime-owned ports remain separate fields for internal SDK use
 */
interface ViewRuntimeContextValue {
  // ═══════════════════════════════════════════════════════════
  // 公共 API - 应用开发者可使用
  // ═══════════════════════════════════════════════════════════

  /** View 元数据 (viewId, appId, desktopId, markDirty) */
  readonly meta: Readonly<IViewMeta>;

  // ═══════════════════════════════════════════════════════════
  // 内部 API - 仅 SDK 组件/Hooks 使用
  // ═══════════════════════════════════════════════════════════

  /** Ref 注册表 - useArrayRef, useRef */
  readonly refs: Readonly<IRefRegistry>;

  /** M4 Stage 1: View-local binding; not yet published to Agent tools. */
  readonly viewTools?: Readonly<{
    readonly targetSelectorSupport?: 'argument-v1';
    readonly refDeclarationSupport?: 'snapshot-value-v1';
    readonly safeOrdinaryParametersInvocationSupport?: 'ordinary-v2';
    readonly safeSnapshotValueParametersInvocationSupport?: 'snapshot-value-v2';
    fingerprintReadOnlyParams?(params: unknown, additionalProperties: boolean): Readonly<{ kind: 'ordinary' | 'snapshot-value'; fingerprint: string }>;
    fingerprintOrdinaryParams?(params: unknown, additionalProperties: boolean): string;
    registerTool(name: string, definition: ViewToolDefinition, options: ViewToolRegistrationOptions): () => void;
  }>;

  // ═══════════════════════════════════════════════════════════
  // LLM Output Channel (RFC-011)
  // ═══════════════════════════════════════════════════════════

  /** Actual Provider, when supplied. Component DOM delivery does not provide history. */
  readonly llmOutput?: Readonly<ILLMOutputChannelContext>;
}

// ═══════════════════════════════════════════════════════════════
//  Context 实例
// ═══════════════════════════════════════════════════════════════

/**
 * 统一运行时 Context
 *
 * The single context used by SDK View hooks.
 */
export const ViewRuntimeContext = createContext<ViewRuntimeContextValue | null>(
  null,
);
ViewRuntimeContext.displayName = "AOTUI.ViewRuntime";
