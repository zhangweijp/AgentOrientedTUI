import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Config } from '../src/config/config.js';
import { HostManagerV2 } from '../src/core/host-manager-v2.js';
import { closeDatabase } from '../src/db/index.js';
import { createHostV2 } from '../src/server/host-v2.js';

describe('Standalone Host HTTP', () => {
    it('serves health and dispatches verified default and explicit Feishu accounts', async () => {
        const home = await mkdtemp(join(tmpdir(), 'host-webhook-'));
        vi.stubEnv('HOME', home);
        vi.stubEnv('USERPROFILE', home);
        vi.stubEnv('DB_PATH', join(home, 'host.sqlite'));
        const dispatch = vi.spyOn(HostManagerV2.prototype, 'sendIMMessage').mockResolvedValue(undefined);
        let server: Awaited<ReturnType<typeof createHostV2>> | undefined;
        try {
            await Config.replaceGlobalIm({ enabled: true, channels: { feishu: {
                enabled: true, connectionMode: 'webhook', appId: 'app-default', appSecret: 'synthetic',
                verificationToken: 'default-token', botAgentId: 'default-agent',
                accounts: {
                    'corp%east': { appId: 'app-corp', verificationToken: 'corp-token', botAgentId: 'corp-agent' },
                    offline: { enabled: false, appId: 'app-offline', verificationToken: 'offline-token' },
                },
            } } });
            server = await createHostV2(0);
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing HTTP listen address');
            const base = `http://127.0.0.1:${address.port}`;
            const webhook = (suffix: string, payload: object) => fetch(base + '/api/im/feishu/webhook' + suffix, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            });

            const health = await fetch(base + '/api/health');
            expect(health.status).toBe(200);
            expect(await health.json()).toMatchObject({ status: 'ok', service: 'host-v2' });
            expect((await fetch(base + '/api/topics')).status).toBe(404);
            expect((await fetch(base + '/api/im/sessions')).status).toBe(404);

            const accountPath = '/' + encodeURIComponent('corp%east');
            const challenge = await webhook(accountPath, { type: 'url_verification', token: 'corp-token', challenge: 'approved' });
            expect(challenge.status).toBe(200);
            expect(await challenge.json()).toEqual({ challenge: 'approved' });
            const wrongToken = await webhook(accountPath, { type: 'url_verification', token: 'default-token', challenge: 'wrong' });
            expect(wrongToken.status).toBe(401);
            const invalidEvent = await webhook('', { token: 'default-token' });
            expect(invalidEvent.status).toBe(500);

            const event = (token: string, id: string) => ({
                token, header: { event_type: 'im.message.receive_v1' },
                event: {
                    sender: { sender_id: { open_id: 'peer' } },
                    message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}' },
                },
            });
            expect((await webhook('', event('default-token', 'one'))).status).toBe(200);
            expect((await webhook(accountPath, event('corp-token', 'two'))).status).toBe(200);
            await webhook('/offline', event('offline-token', 'three'));
            expect(dispatch).toHaveBeenCalledTimes(2);
            expect(dispatch.mock.calls.map(([message]) => [message.accountId, message.botIdentity, message.agentId, message.body]))
                .toEqual([[undefined, 'app-default', 'default-agent', 'hello'], ['corp%east', 'app-corp', 'corp-agent', 'hello']]);
        } finally {
            if (server?.listening) {
                const closed = once(server, 'close');
                server.close();
                await closed;
            }
            dispatch.mockRestore();
            closeDatabase();
            vi.unstubAllEnvs();
            await rm(home, { recursive: true, force: true });
        }
    });
});
