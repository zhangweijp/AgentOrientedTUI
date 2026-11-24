import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';

const root = process.env.AOTUI_BATCH_THREE_MODULES;
if (!isMainThread && root) registerHooks({
    load(url, context, next) {
        appendFileSync(join(root, threadId + '.jsonl'), JSON.stringify(url) + '\n');
        return next(url, context);
    },
});
