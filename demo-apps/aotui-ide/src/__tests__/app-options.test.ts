import { resolveIDEOptions } from '../core/app-options.js';

describe('standard IDE launch', () => {
    const context = { desktopId: 'topic-a', appId: 'app_0', launchConfig: {
        AOTUI_DATA_DIR: '/tmp/aotui-test', projectPath: '/tmp/workspace',
    } };

    it('derives default storage from the current Desktop and generated App ID', () => {
        const first = resolveIDEOptions(context);
        expect(first.projectPath).toBe('/tmp/workspace');
        expect(first.sessionPath).toBe(`/tmp/aotui-test/ide-sessions/${first.sessionKey}/session.json`);
        expect(first.historyPath).toBe(`/tmp/aotui-test/ide-sessions/${first.sessionKey}/history.json`);
        expect(resolveIDEOptions(context)).toEqual(first);
        const reordered = resolveIDEOptions({ ...context, appId: 'app_7' });
        expect(reordered.sessionKey).not.toBe(first.sessionKey);
        expect(reordered.sessionPath).not.toBe(first.sessionPath);
        expect(reordered.historyPath).not.toBe(first.historyPath);
    });

    it('separates Desktop IDs', () => {
        const first = resolveIDEOptions(context);
        expect(resolveIDEOptions({ ...context, desktopId: 'topic-b' }).sessionKey).not.toBe(first.sessionKey);
    });

    it('preserves explicit session settings and rejects invalid storage identities', () => {
        expect(resolveIDEOptions({ ...context, launchConfig: {
            ideSessionKey: 'existing-session',
            ideSessionPath: '/tmp/existing/session.json',
            ideHistoryPath: '/tmp/existing/history.json',
        } })).toMatchObject({
            sessionKey: 'existing-session',
            sessionPath: '/tmp/existing/session.json',
            historyPath: '/tmp/existing/history.json',
        });
        expect(() => resolveIDEOptions({ ...context, launchConfig: { ideSessionKey: '../escape' } }))
            .toThrow('IDE_SESSION_KEY_REQUIRED');
        expect(() => resolveIDEOptions({ ...context, launchConfig: { ideSessionPath: 'relative/session.json' } }))
            .toThrow('IDE_SESSION_PATH_INVALID');
    });
});
