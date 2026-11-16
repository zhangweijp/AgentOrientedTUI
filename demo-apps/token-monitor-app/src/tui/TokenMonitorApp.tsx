import { defineViewType, createTUIApp, View, useCallback, useEffect, useLLMUsage, useRef, useState } from '@aotui/sdk';
import type { LLMUsageEvent } from '@aotui/sdk';
import { RootView } from './RootView.js';
import { MonitorView } from './MonitorView.js';
import type { TokenMonitorSettings } from '../types.js';

const RootType = defineViewType({ name: 'Root' });
const MonitorType = defineViewType({ name: 'TokenMonitor' });

function TokenMonitorRoot() {
    const [settings, setSettings] = useState<TokenMonitorSettings>({
        warnThresholdPercent: 75
    });
    const [history, setHistory] = useState<LLMUsageEvent[]>([]);
    const [modelLimits, setModelLimits] = useState<Record<string, number | null>>({});
    const modelLimitsRef = useRef(modelLimits);
    const modelsDevCacheRef = useRef<{ data?: any; promise?: Promise<any> }>({});

    useEffect(() => {
        modelLimitsRef.current = modelLimits;
    }, [modelLimits]);

    const fetchModelsDevData = async () => {
        if (modelsDevCacheRef.current.data) {
            return modelsDevCacheRef.current.data;
        }
        if (modelsDevCacheRef.current.promise) {
            return modelsDevCacheRef.current.promise;
        }
        const promise = fetch('https://models.dev/api.json')
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`models.dev API failed: ${response.statusText}`);
                }
                return response.json();
            })
            .then((data) => {
                modelsDevCacheRef.current.data = data;
                return data;
            })
            .finally(() => {
                modelsDevCacheRef.current.promise = undefined;
            });
        modelsDevCacheRef.current.promise = promise;
        return promise;
    };

    const resolveModelLimit = async (providerId: string, modelId: string) => {
        const key = `${providerId}:${modelId}`;
        if (modelLimitsRef.current[key] !== undefined) {
            return;
        }
        setModelLimits((prev) => ({ ...prev, [key]: null }));
        try {
            const data = await fetchModelsDevData();
            const limit = data?.[providerId]?.models?.[modelId]?.limit?.context ?? null;
            setModelLimits((prev) => ({ ...prev, [key]: limit }));
        } catch {
            setModelLimits((prev) => ({ ...prev, [key]: null }));
        }
    };

    const updateSettings = useCallback((next: TokenMonitorSettings) => {
        setSettings(next);
    }, []);

    const handleUsage = useCallback((snapshot: LLMUsageEvent) => {
        setHistory((prev: LLMUsageEvent[]) => {
            const next = [...prev, snapshot];
            return next.slice(-10);
        });
    }, []);

    useLLMUsage(event => {
        handleUsage(event);
        void resolveModelLimit(event.providerId, event.modelId);
    });

    const latest = history.length > 0 ? history[history.length - 1] : undefined;
    const latestKey = latest && `${latest.providerId}:${latest.modelId}`;
    const latestMaxTokens = latestKey ? modelLimits[latestKey] ?? null : null;
    const usagePercent = latest && latestMaxTokens
        ? Math.round((latest.totalTokens / latestMaxTokens) * 100)
        : null;
    const shouldWarn = usagePercent !== null && usagePercent >= settings.warnThresholdPercent;

    return (
        <>
            <View id="root" type={RootType} kind="instruction" name="Root">
                <RootView settings={settings} onUpdateSettings={updateSettings} />
            </View>
            {shouldWarn ? (
                <View id="monitor" type={MonitorType} kind="state" name="Token Monitor">
                    <MonitorView settings={settings} history={history} latestMaxTokens={latestMaxTokens} />
                </View>
            ) : null}
        </>
    );
}

export default createTUIApp({
    viewTypes: [RootType, MonitorType],
    app_name: 'token_monitor',
    whatItIs: 'A real-time token usage monitoring system that tracks LLM context consumption, automatically resolves model limits from models.dev, and warns when usage exceeds configurable thresholds. Maintains a history of the last 10 usage snapshots for trend analysis.',
    whenToUse: 'Use Token Monitor when you need to: (1) Track real-time token consumption during LLM interactions, (2) Avoid context overflow by monitoring usage percentage, (3) Optimize prompt efficiency by analyzing token usage patterns, (4) Set custom warning thresholds for proactive alerts, (5) Review historical usage trends from recent interactions.',
    component: TokenMonitorRoot,
    signalPolicy: 'never'
});
