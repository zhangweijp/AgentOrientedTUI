import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { desktopManager, desktopManagerReady } from '../core/desktop-manager.js';
import { initializeLLMConfigService, type LLMConfigService } from '../core/llm-config-service.js';
import { HostManagerV2 } from '../core/host-manager-v2.js';
import * as db from '../db/index.js';
import { FeishuChannelPlugin } from '../im/channels/feishu/channel.js';
import { IMRuntimeBridge } from '../im/im-runtime-bridge.js';
import { ModelRegistry } from '../services/model-registry.js';

export async function createHostV2Core(modelRegistry: ModelRegistry): Promise<{
    hostManager: HostManagerV2;
    llmConfigService: LLMConfigService;
    imRuntimeBridge: IMRuntimeBridge;
}> {
    // 1. Wait for Runtime initialization
    await desktopManagerReady;
    console.log('[HostV2] DesktopManager initialized');

    // 2. Initialize database
    await db.initDatabase();

    // 3. Create LLM Config Service (with ModelRegistry) and initialize singleton
    const llmConfigService = initializeLLMConfigService(modelRegistry);

    // 初始化默认配置
    llmConfigService.initializeDefaultConfigs();
    console.log('[HostV2] LLM Config Service initialized');

    // 4. Create HostManager V2 (with ModelRegistry)
    const hostManager = new HostManagerV2('default_topic', modelRegistry);
    console.log('[HostV2] HostManager V2 initialized');

    // 5. 获取 Kernel (SessionManagerV3 will create Desktops on-demand)
    const kernel = desktopManager.getKernel();
    console.log('[HostV2] Kernel ready for Session-based Desktop creation');

    await hostManager.initAgentDriver(kernel, desktopManager);

    const activeConfig = await llmConfigService.getActiveLLMConfig();
    if (activeConfig) {
        console.log('[HostV2] SessionManagerV3 initialized via HostManager with config:', activeConfig.model);
    } else {
        console.warn('[HostV2] SessionManagerV3 initialized without active LLM config; awaiting user configuration');
    }

    const imRuntimeBridge = new IMRuntimeBridge({
      hostManager,
      createChannelPlugins: (dispatch) => [
        new FeishuChannelPlugin({ dispatch }),
      ],
    });
    await imRuntimeBridge.start();
    hostManager.setIMRuntimeProvider(() => imRuntimeBridge.getRuntime());
    console.log('[HostV2] IM Runtime Bridge initialized');

    return { hostManager, llmConfigService, imRuntimeBridge };
}

export async function createHostV2(port = 8080, modelRegistry = new ModelRegistry()): Promise<Server> {
    const { hostManager, imRuntimeBridge } = await createHostV2Core(modelRegistry);
    const app = express();
    app.use(express.json());

    app.post(['/api/im/feishu/webhook', '/api/im/feishu/webhook/:accountId'], async (req, res) => {
        const { accountId } = req.params as { accountId?: string };
        try {
            const result = await imRuntimeBridge.processFeishuWebhook(req.body, accountId);
            res.status(result.status).json(result.body);
        } catch (error) {
            console.error('[HostV2] Error processing Feishu webhook:', error);
            res.status(500).json({ code: 1, msg: accountId
                ? 'Failed to process Feishu account webhook'
                : 'Failed to process Feishu webhook' });
        }
    });

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'host-v2', timestamp: Date.now() });
    });

    const server = createServer(app);
    const dispose = async () => {
        try {
            await imRuntimeBridge.stop();
        } finally {
            await hostManager.dispose();
        }
    };

    try {
        const listening = once(server, 'listening');
        server.listen(port);
        await listening;
    } catch (error) {
        await dispose();
        throw error;
    }
    server.once('close', () => {
        void dispose().catch(error => console.error('[HostV2] Shutdown failed:', error));
    });
    return server;
}
