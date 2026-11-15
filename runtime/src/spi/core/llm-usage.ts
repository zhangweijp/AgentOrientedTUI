/** Usage reported by the Host for a completed model request. */
export interface LLMUsageEvent {
    readonly timestamp: number;
    readonly providerId: string;
    readonly modelId: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
}
