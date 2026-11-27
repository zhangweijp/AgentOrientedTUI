import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = realpathSync(process.env.AOTUI_CONSUMER_ROOT);
const inside = file => file === root || file.startsWith(root + path.sep);
registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (context.parentURL?.startsWith('file:') && inside(fileURLToPath(context.parentURL)) &&
        result.url?.startsWith('file:')) {
        const target = realpathSync(fileURLToPath(result.url));
        if (!inside(target)) {
            const code = Array.from(context.conditions).includes('require') ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND';
            throw Object.assign(new Error('Consumer resolution escaped its own installation: ' + specifier + ' -> ' + target), { code });
        }
    }
    return result;
} });
