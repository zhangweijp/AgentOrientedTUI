import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelCall, watchUntil } from './batch-two-support.mjs';

export const APP = 'window_files';
export const INPUT = 23_000;
export const OUTPUT = 750;
export const A_NOTE = 'Check A <later> & keep the original note.';
export const APP_NOTE = 'Return to this workspace <later> & keep the context.';
export const tool = (name) => APP + '-' + name;
export const openFiles = (id, ...names) => modelCall(id, tool('open_file'), { names });
export const onFile = (id, operation, file, args = {}) => modelCall(id, tool(operation), { view_id: 'file_' + file, ...args });
export const windowAction = (id, action, file, args = {}) => modelCall(id, 'system-' + action,
    { app_id: APP, ...(file ? { view_id: 'file_' + file } : {}), ...args });
export const wirePages = wire => wire.messages.filter(message => typeof message.content === 'string' && message.content.startsWith('<view '));
export const pageFor = (wire, name, appId = APP) => wirePages(wire).find(message =>
    message.content.startsWith('<view view_id="file_' + name + '"') && message.content.split('\n', 1)[0].includes(` app_id="${appId}"`))?.content;
export const namesOf = wire => wire.tools.map(tool => tool.function.name);
export const currentReportId = wire => wire.messages.find(message => message.content?.startsWith?.('<desktop>'))
    ?.content.match(/\breport_id ([a-f0-9-]{36})\b/)?.[1];

export function wireCost(wire, limit = INPUT, serialized = JSON.stringify(wire)) {
    const inputBytes = Buffer.byteLength(serialized, 'utf8');
    const safety = Math.max(256, Math.ceil(inputBytes * 0.05)) + 8 * (wire.messages.length + wire.tools.length);
    return { method: 'utf8-bytes', inputBytes, safety, estimated: inputBytes + safety, inputLimit: limit, outputReserved: OUTPUT };
}

export async function setupFiles(folder, b = 'B-INITIAL') {
    await mkdir(folder, { recursive: true });
    await Promise.all(['A', 'B', 'C', 'D', 'E'].map(name => writeFile(join(folder, name + '.txt'),
        name === 'A' ? 'A-BODY ' + 'a'.repeat(7_200) : name === 'B' ? b : name + '-BODY')));
}

export async function updateFile(folder, client, name, content, remount) {
    await writeFile(join(folder, name + '.txt'), content);
    const command = join(folder, 'fixture-update.json');
    await writeFile(command + '.next', JSON.stringify({ name, remount, unique: Date.now() }));
    await rename(command + '.next', command);
    return watchUntil(async () => {
        const result = await client.preview();
        return result.status === 'previewed' && result.views.some(view => view.id === 'file_' + name && view.content.value.includes(content)) && result;
    });
}
