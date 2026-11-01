import type { RuntimeConfigInput } from '../../../src/spi/config/types.js';

const supported: RuntimeConfigInput = {
    worker: { timeoutMs: 60_000, pool: { maxSize: 12 } },
    logger: { maxSystemLogs: 200 },
};
void supported;

// @ts-expect-error bridge.debounceMs has no Runtime consumer or configuration contract.
const obsoleteBridge: RuntimeConfigInput = { bridge: { debounceMs: 300 } };
// @ts-expect-error transform settings have no Runtime consumer or configuration contract.
const obsoleteTransform: RuntimeConfigInput = { transform: { domThrottleMs: 16, maxTreeDepth: 20 } };
void obsoleteBridge;
void obsoleteTransform;
