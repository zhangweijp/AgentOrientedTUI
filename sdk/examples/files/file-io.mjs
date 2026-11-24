import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

export function fileIO(folder) {
    return {
        read(name) { return readFileSync(join(folder, name), 'utf8'); },
        write(name, text) {
            writeFileSync(join(folder, name), text);
            appendFileSync(join(folder, 'writes.jsonl'), JSON.stringify({ name, text, threadId }) + '\n');
        },
    };
}
