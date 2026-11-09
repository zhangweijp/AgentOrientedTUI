import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileWithParents } from '../core/observed-file-actions.js';
import { directoryIdentity } from '../core/versioned-file-write.js';

describe('P0: create_file must never overwrite an existing file', () => {
    let directory: string;
    let identity: string;

    beforeEach(async () => {
        directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aotui-ide-exclusive-')));
        identity = await directoryIdentity(directory);
    });

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('creates a new file and its parent directories without touching another file', async () => {
        const file = path.join(directory, 'nested', 'new-file.ts');
        await createFileWithParents(directory, identity, file, 'export const initial = true;\n', () => {});
        expect(await fs.readFile(file, 'utf8')).toBe('export const initial = true;\n');
        const sibling = path.join(directory, 'nested', 'existing.ts');
        await fs.writeFile(sibling, 'DO NOT TOUCH');
        await expect(createFileWithParents(directory, identity, sibling, 'overwrite', () => {})).rejects.toThrow(
            /RESOURCE_ALREADY_EXISTS/,
        );
        expect(await fs.readFile(sibling, 'utf8')).toBe('DO NOT TOUCH');
    });

    it('concurrent creators of the same path cannot overwrite each other', async () => {
        const file = path.join(directory, 'concurrent', 'new-file.ts');
        await fs.mkdir(path.dirname(file));
        const proposed = Array.from({ length: 8 }, (_, index) =>
            'unique complete payload ' + index + '\n',
        );
        const results = await Promise.allSettled(proposed.map(
            content => createFileWithParents(directory, identity, file, content, () => {}),
        ));
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(7);
        for (const result of results) {
            if (result.status === 'rejected') {
                expect(String(result.reason)).toMatch(/RESOURCE_ALREADY_EXISTS/);
            }
        }
        const final = await fs.readFile(file, 'utf8');
        expect(proposed).toContain(final);
        expect(final).not.toContain('overwrite');
    });

    it('does not truncate a pre-existing empty file', async () => {
        const file = path.join(directory, 'existing-empty.ts');
        await fs.writeFile(file, '');
        await expect(createFileWithParents(directory, identity, file, 'new value', () => {}))
            .rejects.toThrow(/RESOURCE_ALREADY_EXISTS/);
        expect(await fs.readFile(file, 'utf8')).toBe('');
    });
});
