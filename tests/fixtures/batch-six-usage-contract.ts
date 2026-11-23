import type { LanguageModelUsage as AIUsage } from 'ai';
import type { AgentDriverV2Config, LanguageModelUsage } from '@aotui/agent-driver-v2';
import type { IDesktop } from '@aotui/runtime';
import type { AppInstance } from '@aotui/core';
// @ts-expect-error The type belongs to the Driver's host contract.
import type { LLMUsageEvent } from '@aotui/runtime';
// @ts-expect-error There is no App-side usage hook.
import { useLLMUsage } from '@aotui/sdk';
// @ts-expect-error The SDK provides no model event bridge.
import { dispatchDOMAppEvent } from '@aotui/sdk';

export const onUsage: NonNullable<AgentDriverV2Config['onLLMUsage']> = (usage: LanguageModelUsage) => {
    const value: AIUsage = usage;
    const input: number | undefined = value.inputTokens;
    const output: number | undefined = value.outputTokens;
    const source = value.raw;
    // @ts-expect-error V5 consumer field.
    value.promptTokens;
    // @ts-expect-error V5 consumer field.
    value.completionTokens;
    void [input, output, source];
};
export function retiredMethods(app: AppInstance, desktop: IDesktop) {
    // @ts-expect-error Usage notifications stay in the Host.
    app.onLLMUsage;
    // @ts-expect-error Desktops do not broadcast model usage.
    desktop.broadcastLLMUsage;
}
