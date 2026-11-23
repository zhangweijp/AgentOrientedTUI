import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAIL_TOOL, modelCall, watchUntil } from './batch-two-support.mjs';

export const firstEmail = 'first@example.test';
export const originalPeople = [
    { email: firstEmail, phone: 'synthetic-private-first' },
    { email: 'second@example.test', phone: 'synthetic-private-second' },
    ...Array.from({ length: 98 }, (_, index) => ({ email: 'unused-' + index + '@example.test', phone: 'synthetic-private-' + index })),
];
export const changedPeople = [originalPeople[1]];
export const emailAddress = '$contacts.list.people[0].email';
export const deniedAddresses = ['$contacts.list.people', '$contacts.list.people[0]', '$contacts.list.people[0].phone',
    '$contacts.list.people[0].not_here', '$contacts.list.people[1].email', '$contacts.list.people[100].email'];
export const expectedHint = '- public ' + emailAddress + ' (string) for app_id mail, view_id draft';
export const hasPrivateDetails = value => /phone|synthetic-private|Parent directory schema|unused-/.test(JSON.stringify(value));

const phoneAddress = '$contacts.list.people[0].phone';
const phoneHint = '- public ' + phoneAddress + ' (string) for app_id mail_1, view_id draft';
export const unscopedHint = '- public $contacts.list.people[1].email (string)';
export const secondMailTool = 'mail_1-set_recipients';
export const secondDraftValue = originalPeople[0].phone;

export function draftFieldGrants(consumer, secondary, allowedPaths = [[0, 'email']]) {
    const paths = consumer ? allowedPaths.map(path => ({ path, consumer })) : [];
    return secondary ? [...paths, { path: [0, 'phone'], consumer: secondary }, { path: [1, 'email'] }] : paths;
}

export const mixedTurns = {
    both: { label: 'both receiving mounts', hints: [expectedHint, phoneHint, unscopedHint],
        calls: [modelCall('allowed-secondary', secondMailTool, { to: phoneAddress })] },
    missing: { label: 'secondary absent from request', hints: [expectedHint, unscopedHint],
        calls: [modelCall('absent-secondary-field', MAIL_TOOL, { to: phoneAddress })] },
    replaced: { label: 'secondary same-name remount', hints: [expectedHint, unscopedHint], calls: [
        modelCall('stale-secondary-field', secondMailTool, { to: phoneAddress }),
        modelCall('still-valid-primary', MAIL_TOOL, { to: emailAddress }),
    ] },
};

export const viewMessages = wire => wire.messages.filter(message => message.role === 'user' && message.content.startsWith('<view '));
export const referenceHints = markup => markup.split('\n').filter(line => line.startsWith('- public '));

export function contactHints(wire) {
    const page = viewMessages(wire).find(message => message.content.split('\n', 1)[0].includes(' app_id="contacts" '));
    if (!page) throw new Error('The request omitted the contacts page');
    return referenceHints(page.content);
}

export async function setPeople(folder, revision, people = originalPeople, withdrawn = false) {
    await mkdir(folder, { recursive: true });
    const path = join(folder, 'people.json');
    await writeFile(path + '.next', JSON.stringify({ revision, people, withdrawn }));
    await rename(path + '.next', path);
}

export function waitForView(client, text) {
    return watchUntil(async () => {
        const preview = await client.preview();
        return preview.status === 'previewed' && preview.views.some(view => view.content.value.includes(text)) && preview;
    });
}
