import { resolveIDEOptions } from '../core/app-options.js';

describe('standard IDE launch', () => {
    const context = { desktopId: 'topic-a', appId: 'app_0', launchConfig: {
        AOTUI_APP_KEY: 'system_ide', AOTUI_DATA_DIR: '/tmp/aotui-test', projectPath: '/tmp/workspace',
    } };

    it('derives default storage from the current Desktop and generated App ID', () => {
        const first = resolveIDEOptions(context);
        expect(first.projectPath).toBe('/tmp/workspace');
        expect(first.historyPath).toBe(`/tmp/aotui-test/ide-sessions/${first.sessionKey}/history.json`);
        expect(resolveIDEOptions(context)).toEqual(first);
        const reordered = resolveIDEOptions({ ...context, appId: 'app_7' });
        expect(reordered.sessionKey).not.toBe(first.sessionKey);
        expect(reordered.historyPath).not.toBe(first.historyPath);
    });

    it('separates Desktop IDs and leaves the Host storage key to Runtime', () => {
        const first = resolveIDEOptions(context);
        expect(resolveIDEOptions({ ...context, desktopId: 'topic-b' }).sessionKey).not.toBe(first.sessionKey);
        expect(resolveIDEOptions({ ...context, launchConfig: { ...context.launchConfig, AOTUI_APP_KEY: 'other_ide' } }))
            .toEqual(first);
    });

    it('preserves explicit session settings and rejects invalid storage identities', () => {
        expect(resolveIDEOptions({ ...context, launchConfig: {
            ideSessionKey: 'existing-session', ideHistoryPath: '/tmp/existing/history.json',
        } })).toMatchObject({ sessionKey: 'existing-session', historyPath: '/tmp/existing/history.json' });
        expect(() => resolveIDEOptions({ ...context, launchConfig: { ideSessionKey: '../escape' } }))
            .toThrow('IDE_SESSION_KEY_REQUIRED');
    });
});
