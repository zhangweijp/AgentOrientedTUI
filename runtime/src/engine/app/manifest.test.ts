import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAppManifest, resolveAppModule } from './manifest.js';
import { createRuntime } from '../../index.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aotui-manifest-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function app(fields: Record<string, unknown> = {}) {
    const modulePath = join(directory, 'dist/entry.mjs');
    const manifestPath = join(directory, 'aoapp.json');
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(modulePath, 'throw new Error("Discovery must not import the App.");');
    await writeFile(manifestPath, JSON.stringify({
        app_name: '3' + 'a'.repeat(50), version: '1.0.0', description: 'Declared description',
        toolAuthoringProtocol: 'view-type-tools-v8', appLifecycleSupport: 'app-lifecycle-v2',
        entry: { main: './dist/entry.mjs' }, ...fields,
    }));
    return { modulePath, manifestPath };
}

it('discovers the same immutable metadata from a directory or its generated entry without importing it', async () => {
    const { modulePath } = await app();
    const result = await readAppManifest(directory);
    expect(result).toEqual({ metadata: { app_name: '3' + 'a'.repeat(50), description: 'Declared description' }, modulePath });
    expect(Object.isFrozen(result) && Object.isFrozen(result.metadata)).toBe(true);
    expect(await readAppManifest(modulePath)).toEqual(result);
    expect(await readAppManifest(pathToFileURL(modulePath).href)).toEqual(result);
    expect(() => resolveAppModule(modulePath, 'other')).toThrow(expect.objectContaining({
        code: 'APP_IDENTITY_MISMATCH', context: expect.objectContaining({ path: 'options.name' }),
    }));
});

it('rejects unmatched and nonexistent explicit files without falling back to the declared entry', async () => {
    const { manifestPath } = await app();
    const other = join(directory, 'dist/other.mjs'), missing = join(directory, 'missing.mjs');
    await writeFile(other, '');
    await expect(readAppManifest(other)).rejects.toMatchObject({
        code: 'APP_IDENTITY_MISMATCH', context: { path: manifestPath + '#entry.main' },
    });
    await expect(readAppManifest(missing)).rejects.toMatchObject({ code: 'APP_MANIFEST_INVALID', context: { path: missing } });
});

it.each([
    [{ app_name: '' }, 'APP_MANIFEST_INVALID', 'app_name'],
    [{ entry: { main: './dist/missing.mjs' } }, 'APP_MANIFEST_INVALID', 'entry.main'],
    [{ toolAuthoringProtocol: 'old' }, 'APP_AUTHORING_PROTOCOL_UNSUPPORTED', 'toolAuthoringProtocol'],
    [{ appLifecycleSupport: 'old' }, 'APP_MANIFEST_INVALID', 'appLifecycleSupport'],
] as const)('rejects invalid static fields (%s) with a located diagnostic', async (fields, code, field) => {
    const { manifestPath } = await app(fields);
    const error = await readAppManifest(directory).catch(reason => reason);
    expect(error.code).toBe(code);
    expect(error.path ?? error.context?.path).toContain(manifestPath + '#' + field);
});

it('requires explicit identity for a bare entry and never infers it from package.json', async () => {
    const bare = join(directory, 'bare.mjs');
    await writeFile(bare, '');
    await writeFile(join(directory, 'package.json'), '{"main":"bare.mjs"}');
    await expect(readAppManifest(directory)).rejects.toMatchObject({ code: 'APP_MANIFEST_INVALID' });
    expect(() => resolveAppModule(bare)).toThrow(expect.objectContaining({ code: 'APP_MANIFEST_INVALID' }));
    expect(resolveAppModule(bare, 'bare').metadata.app_name).toBe('bare');
});

it('admits two installations of the same manifest on one empty Desktop without starting either', async () => {
    const { modulePath } = await app();
    const runtime = createRuntime();
    const desktop = await runtime.createDesktop();
    try {
        await expect(desktop.registerPendingApp({ installationId: 'a', localPath: directory })).resolves.toBe('a');
        await expect(desktop.registerPendingApp({ installationId: 'b', localPath: modulePath })).resolves.toBe('b');
        await expect(desktop.registerPendingApp({ installationId: 'a', localPath: directory }))
            .rejects.toMatchObject({ code: 'APP_ALREADY_EXISTS' });
        expect(desktop.listApps().map(item => [item.installationId, item.status, item.appId, item.description]))
            .toEqual([['a', 'pending', undefined, 'Declared description'], ['b', 'pending', undefined, 'Declared description']]);
    } finally {
        const report = await runtime.beginClose().completion;
        expect(report).toMatchObject({ resourcesReleased: true, workers: { report: { total: 0 } } });
    }
});
