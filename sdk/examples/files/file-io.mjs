import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

const { O_RDONLY, O_WRONLY, O_CREAT, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = constants;
const journal = 'writes.jsonl';
const unavailable = new Set(['EACCES', 'EISDIR', 'ELOOP', 'EMLINK', 'ENAMETOOLONG', 'ENOENT', 'ENOTDIR', 'ENXIO', 'EPERM', 'EROFS']);
const invalidName = process.platform === 'win32' ? /[\\/\0:]|[. ]$/ : /[\\/\0]/;

function isFileName(name) {
    return name !== '' && name !== '.' && name !== '..' && name.toLowerCase() !== journal && !invalidName.test(name);
}

function useFile(folder, name, flags, operation) {
    const path = join(folder, name);
    const create = Boolean(flags & O_CREAT);
    let fd;
    try {
        if (!create && !readdirSync(folder).includes(name)) return;
        const entry = lstatSync(path, { throwIfNoEntry: false });
        if (entry ? !entry.isFile() : !create) return;
        fd = openSync(path, flags | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
        if (unavailable.has(error.code)) return;
        throw error;
    }
    try {
        if (fstatSync(fd).isFile()) return operation(fd);
    } finally {
        closeSync(fd);
    }
}

export function fileIO(folder) {
    return {
        list() {
            return readdirSync(folder, { withFileTypes: true })
                .filter(entry => entry.isFile() && isFileName(entry.name))
                .map(entry => entry.name)
                .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        },
        read(name) {
            if (isFileName(name)) return useFile(folder, name, O_RDONLY, fd => readFileSync(fd, 'utf8'));
        },
        write(name, text) {
            if (!isFileName(name)) return false;
            const written = useFile(folder, name, O_WRONLY, fd => {
                ftruncateSync(fd, 0);
                writeFileSync(fd, text);
                return true;
            });
            if (!written) return false;
            useFile(folder, journal, O_WRONLY | O_CREAT | O_APPEND, fd =>
                writeFileSync(fd, JSON.stringify({ name, text, threadId }) + '\n'));
            return true;
        },
    };
}
