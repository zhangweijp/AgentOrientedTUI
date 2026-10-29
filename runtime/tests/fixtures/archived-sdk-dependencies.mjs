import { mkdir, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function linkArchivedSdkDependencies(repo, target) {
    const source = join(repo, 'sdk/node_modules');
    const modules = join(target, 'node_modules');
    await mkdir(modules, { recursive: true });
    for (const name of await readdir(source)) {
        if (name !== '@preact') await symlink(join(source, name), join(modules, name), 'dir');
    }
    await mkdir(join(modules, '@preact'));
    await symlink(join(repo, 'runtime/node_modules/@preact/signals'), join(modules, '@preact/signals'), 'dir');
}
