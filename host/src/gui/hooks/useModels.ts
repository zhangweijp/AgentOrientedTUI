import { useEffect, useState } from 'react';
import { useChatBridge } from '../ChatBridge.js';
import type { ModelsDevModel } from '../../services/index.js';

/**
 * Sort models with active model first
 */
export function sortModels(models: ModelsDevModel[], activeModelId: string | null): ModelsDevModel[] {
    if (!activeModelId) {
        return models;
    }

    return [...models].sort((a, b) => {
        if (a.id === activeModelId && b.id !== activeModelId) return -1;
        if (a.id !== activeModelId && b.id === activeModelId) return 1;
        return 0;
    });
}

export function useModels(providerId: string | null) {
    const bridge = useChatBridge();
    const [models, setModels] = useState<ModelsDevModel[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        setModels([]);
        setError(null);
        setIsLoading(providerId !== null);
        if (!providerId) return;
        let current = true;
        async function load(providerId: string) {
            try {
                const result = await bridge.getTrpcClient().modelRegistry.getModels.query({ providerId });
                if (current) setModels(result);
            } catch (cause) {
                if (current) setError(cause instanceof Error ? cause : new Error(String(cause)));
            } finally {
                if (current) setIsLoading(false);
            }
        }
        void load(providerId);
        return () => { current = false; };
    }, [bridge, providerId]);

    return { models, isLoading, error };
}
