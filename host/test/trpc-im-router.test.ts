import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { Config } from '../src/config/config.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('tRPC im router', () => {
    let caller: ReturnType<typeof appRouter.createCaller>;
    let hostManager: {
        getIMSessions: ReturnType<typeof vi.fn>;
        getIMSession: ReturnType<typeof vi.fn>;
        getIMMessages: ReturnType<typeof vi.fn>;
        getIMRuntime: ReturnType<typeof vi.fn>;
    };

    let configDir: string;
    let home: string;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'host-im-config-'));
        vi.stubEnv('HOME', home);
        vi.stubEnv('USERPROFILE', home);
        configDir = join(home, '.agentina');
        await mkdir(configDir);

        hostManager = {
            getIMSessions: vi.fn(() => []),
            getIMSession: vi.fn(() => null),
            getIMMessages: vi.fn(() => []),
            getIMRuntime: vi.fn(() => ({})),
        };
        caller = appRouter.createCaller({
            hostManager: hostManager as any,
            llmConfigService: {} as any,
            modelRegistry: {} as any,
            messageService: {} as any,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
    });

    it('keeps IM in mcp.json inactive and leaves the file intact', async () => {
        const mcpFile = join(configDir, 'mcp.json');
        const legacy = '{"im":{"enabled":true,"channels":{"feishu":{"enabled":true}}}}';
        await writeFile(mcpFile, legacy);
        expect(await caller.im.getConfig()).toEqual({ im: {} });
        expect((await Config.get()).im).toEqual({});
        expect(await readFile(mcpFile, 'utf8')).toBe(legacy);
    });

    it.each([
        { disabled: true, channels: { feishu: { enabled: true } } },
        { channels: { feishu: { enabled: true, disabled: true } } },
        { channels: { feishu: { enabled: true, accounts: { main: { enabled: true, disabled: true } } } } },
    ])('rejects retired disabled flags on read and write', async im => {
        const file = join(configDir, 'im.json');
        const legacy = JSON.stringify({ im });
        await writeFile(file, legacy);
        expect(await caller.im.getConfig()).toMatchObject({ im: { enabled: false }, issue: expect.stringContaining('Reconfigure IM') });
        expect((await Config.get()).im?.enabled).toBe(false);
        await expect(caller.im.updateConfig({ im })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(await readFile(file, 'utf8')).toBe(legacy);
    });

    it('replaces retired IM settings with the current switches and session policies', async () => {
        const file = join(configDir, 'im.json');
        await writeFile(file, '{"im":{"disabled":true}}');
        const im = {
            enabled: false,
            channels: {
                feishu: {
                    enabled: true, sessionScope: 'peer_sender', groupPolicy: 'disabled', allowFrom: ['someone'],
                    accounts: { main: { enabled: false, sessionScope: 'peer_thread_sender', appId: 'synthetic' } },
                },
            },
        } as const;
        await expect(caller.im.updateConfig({ im: { ...im, channels: { feishu: { ...im.channels.feishu, allowFrom: ['someone'] } } } }))
            .resolves.toEqual({ success: true });
        expect(await caller.im.getConfig()).toEqual({ im });
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ im });
    });

    it('getRuntime delegates to hostManager runtime surface', async () => {
        hostManager.getIMRuntime.mockReturnValue({
            started: true,
            channels: [
                {
                    id: 'feishu',
                    meta: { label: 'Feishu' },
                    capabilities: { chatTypes: ['direct', 'group'], threads: true },
                    active: true,
                    runtime: {
                        started: true,
                        connectionMode: 'websocket',
                        accountIds: ['default'],
                        sessionScopes: ['peer', 'peer_thread'],
                    },
                },
            ],
        });

        const result = await caller.im.getRuntime();
        expect(hostManager.getIMRuntime).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            started: true,
            channels: [
                {
                    id: 'feishu',
                    meta: { label: 'Feishu' },
                    capabilities: { chatTypes: ['direct', 'group'], threads: true },
                    active: true,
                    runtime: {
                        started: true,
                        connectionMode: 'websocket',
                        accountIds: ['default'],
                        sessionScopes: ['peer', 'peer_thread'],
                    },
                },
            ],
        });
    });

    it('listSessions delegates to hostManager IM query surface', async () => {
        hostManager.getIMSessions.mockReturnValue([
            {
                sessionKey: 'agent:a:feishu:direct:ou_1',
                agentId: 'agent-a',
                channel: 'feishu',
                chatType: 'direct',
                peerId: 'ou_1',
                createdAt: 1,
                updatedAt: 2,
                lastAccessTime: 2,
            },
        ]);

        const result = await caller.im.listSessions();

        expect(hostManager.getIMSessions).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0].sessionKey).toBe('agent:a:feishu:direct:ou_1');
    });

    it('getSession delegates to hostManager IM query surface', async () => {
        hostManager.getIMSession.mockReturnValue({
            sessionKey: 'agent:a:feishu:group:oc_1',
            agentId: 'agent-a',
            channel: 'feishu',
            chatType: 'group',
            peerId: 'oc_1',
            accountId: 'tenant-1',
            createdAt: 1,
            updatedAt: 3,
            lastAccessTime: 3,
        });

        const result = await caller.im.getSession({ sessionKey: 'agent:a:feishu:group:oc_1' });

        expect(hostManager.getIMSession).toHaveBeenCalledWith('agent:a:feishu:group:oc_1');
        expect(result?.accountId).toBe('tenant-1');
    });

    it('getMessages delegates to hostManager IM message query surface', async () => {
        hostManager.getIMMessages.mockReturnValue([
            { role: 'user', content: 'hello', timestamp: 1_000 },
            { role: 'assistant', content: 'world', timestamp: 1_100 },
        ]);

        const result = await caller.im.getMessages({ sessionKey: 'agent:a:feishu:direct:ou_9' });

        expect(hostManager.getIMMessages).toHaveBeenCalledWith('agent:a:feishu:direct:ou_9');
        expect(result).toEqual([
            { role: 'user', content: 'hello', timestamp: 1_000 },
            { role: 'assistant', content: 'world', timestamp: 1_100 },
        ]);
    });
});
