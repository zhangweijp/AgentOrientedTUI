import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { IDEOptions } from './ide-session.js';
import { requireIDE } from './ide-errors.js';

/** IDE session storage is an application concern; Hosts only provide normal launch context. */
export function resolveIDEOptions(context: {
    desktopId: string;
    appId: string;
    launchConfig?: Record<string, unknown>;
}): IDEOptions {
    const config = context.launchConfig ?? {};
    requireIDE(config.ideToolRoute === undefined || config.ideToolRoute === 'scoped', 'IDE_ROUTE_INVALID');
    const appKey = typeof config.AOTUI_APP_NAME === 'string' ? config.AOTUI_APP_NAME : context.appId;
    const defaultKey = 'ide-' + createHash('sha256')
        .update(JSON.stringify([context.desktopId, appKey])).digest('hex').slice(0, 32);
    const sessionKey = config.ideSessionKey ?? defaultKey;
    requireIDE(typeof sessionKey === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(sessionKey), 'IDE_SESSION_KEY_REQUIRED');
    const dataDir = config.AOTUI_DATA_DIR ?? path.join(os.homedir(), '.aotui', 'data');
    requireIDE(typeof dataDir === 'string' && path.isAbsolute(dataDir), 'IDE_DATA_DIR_INVALID');
    const historyPath = config.ideHistoryPath ?? path.join(dataDir, 'ide-sessions', sessionKey, 'history.json');
    requireIDE(typeof historyPath === 'string' && path.isAbsolute(historyPath), 'IDE_HISTORY_PATH_INVALID');
    return {
        sessionKey,
        historyPath,
        projectPath: typeof config.projectPath === 'string' ? config.projectPath : undefined,
        legacyImportPath: typeof config.ideLegacyImportPath === 'string' ? config.ideLegacyImportPath : undefined,
    };
}
