import { resolveIDEOptions } from '../core/app-options.js';

describe('standard IDE launch', () => {
    const context = { desktopId: 'topic-a', appId: 'app_0', launchConfig: {
        AOTUI_APP_NAME: 'system_ide', AOTUI_DATA_DIR: '/tmp/aotui-test', projectPath: '/tmp/workspace',
    } };

    it('needs no IDE-specific Host configuration and keeps storage stable across app installation order', () => {
        const first = resolveIDEOptions(context);
        expect(first.projectPath).toBe('/tmp/workspace');
        expect(first.historyPath).toBe(`/tmp/aotui-test/ide-sessions/${first.sessionKey}/history.json`);
        expect(resolveIDEOptions({ ...context, appId: 'app_7' })).toEqual(first);
    });

    it('isolates topics and distinct registry entries', () => {
        const first = resolveIDEOptions(context);
        expect(resolveIDEOptions({ ...context, desktopId: 'topic-b' }).sessionKey).not.toBe(first.sessionKey);
        expect(resolveIDEOptions({ ...context, launchConfig: { ...context.launchConfig, AOTUI_APP_NAME: 'other_ide' } }).sessionKey)
            .not.toBe(first.sessionKey);
    });

    it('preserves explicit session settings and rejects invalid storage identities', () => {
        expect(resolveIDEOptions({ ...context, launchConfig: {
            ideSessionKey: 'existing-session', ideHistoryPath: '/tmp/existing/history.json',
        } })).toMatchObject({ sessionKey: 'existing-session', historyPath: '/tmp/existing/history.json' });
        expect(() => resolveIDEOptions({ ...context, launchConfig: { ideSessionKey: '../escape' } }))
            .toThrow('IDE_SESSION_KEY_REQUIRED');
    });
});
