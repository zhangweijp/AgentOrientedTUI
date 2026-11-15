import type { LLMUsageEvent } from '@aotui/sdk';
import type { TokenMonitorSettings } from '../types.js';

type MonitorViewProps = {
    settings: TokenMonitorSettings;
    history: LLMUsageEvent[];
    latestMaxTokens: number | null;
};

export function MonitorView({ settings, history, latestMaxTokens }: MonitorViewProps) {
    const latest = history.length > 0 ? history[history.length - 1] : undefined;
    const usagePercent = latest && latestMaxTokens ? Math.round((latest.totalTokens / latestMaxTokens) * 100) : null;
    const warnThreshold = settings.warnThresholdPercent;
    const shouldWarn = usagePercent !== null && usagePercent >= warnThreshold;
    const latestUsagePercent = usagePercent !== null ? `${usagePercent}%` : 'unknown';
    const latestTable = latest
        ? [
            '| timestamp | providerId | modelId | promptTokens | completionTokens | totalTokens | usagePercent |',
            '| --- | --- | --- | --- | --- | --- | --- |',
            `| ${new Date(latest.timestamp).toLocaleTimeString()} | ${latest.providerId} | ${latest.modelId} | ${latest.promptTokens} | ${latest.completionTokens} | ${latest.totalTokens} | ${latestUsagePercent} |`
        ].join('\n')
        : null;

    return (
        <div>
            <h1>Token Monitor View</h1>
            <p>Model max tokens: {latestMaxTokens ?? 'Unknown'}</p>
            <p>Warn threshold: {warnThreshold}%</p>

            <h2>Latest Usage</h2>
            {latest ? (
                <pre>{latestTable}</pre>
            ) : (
                <p>No usage events yet.</p>
            )}

            <h2>Status</h2>
            {latestMaxTokens ? (
                shouldWarn ? (
                    <p>Warning: usage is above the threshold. Consider reducing context.</p>
                ) : (
                    <p>OK: usage is below the threshold.</p>
                )
            ) : (
                <p>Model limit is unavailable for usage percentage.</p>
            )}

        </div>
    );
}
