import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AOTUIError, APP_LIFECYCLE_PROTOCOL, captureAppMetadata, hasViewTypeToolAuthoringProtocol, type AppMetadata } from '@aotui/core';

export interface AppManifest {
    readonly metadata: AppMetadata;
    readonly modulePath: string;
}

function localTarget(localPath: string): string {
    if (typeof localPath !== 'string' || !localPath.trim()) {
        throw new AOTUIError('APP_MANIFEST_INVALID', { path: 'localPath', reason: 'Provide a local App package directory or entry file' });
    }
    try { return resolve(localPath.startsWith('file:') ? fileURLToPath(localPath) : localPath); }
    catch { throw new AOTUIError('APP_MANIFEST_INVALID', { path: localPath, reason: 'Invalid local App path' }); }
}

function statIfPresent(path: string) {
    try { return statSync(path); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
}

/** Read static package data without importing the App. A missing manifest alone permits a bare module. */
function findAppManifest(target: string): AppManifest | undefined {
    let location = target;
    try {
        const info = statIfPresent(target);
        if (!info) return;
        const file = info.isFile();
        if (!file && !info.isDirectory()) throw new TypeError('Provide a directory or entry file');
        let directory = file ? dirname(target) : target;
        for (;;) {
            const manifestPath = location = join(directory, 'aoapp.json');
            if (statIfPresent(manifestPath)) {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                const metadata = captureAppMetadata(manifest);
                location = manifestPath + '#version';
                if (typeof manifest.version !== 'string' || !manifest.version.trim())
                    throw new TypeError('Build the App to generate a manifest with a version');
                if (!hasViewTypeToolAuthoringProtocol(manifest)) throw Object.assign(new Error('The generated manifest declares an unsupported authoring protocol; rebuild with the matching SDK'), {
                    code: 'APP_AUTHORING_PROTOCOL_UNSUPPORTED', path: manifestPath + '#toolAuthoringProtocol',
                });
                location = manifestPath + '#appLifecycleSupport';
                if (manifest.appLifecycleSupport !== APP_LIFECYCLE_PROTOCOL)
                    throw new TypeError('The generated manifest requires the current App lifecycle contract');
                location = manifestPath + '#entry.main';
                if (typeof manifest.entry?.main !== 'string' || !manifest.entry.main.trim())
                    throw new TypeError('Build the App to generate a manifest with entry.main');
                const modulePath = resolve(directory, manifest.entry.main);
                if (file && target !== modulePath)
                    throw new AOTUIError('APP_IDENTITY_MISMATCH', { expected: modulePath, actual: target, path: location });
                if (!statIfPresent(modulePath)?.isFile()) throw new TypeError('The generated entry.main file does not exist; build the App first');
                return Object.freeze({ metadata, modulePath });
            }
            if (!file || statIfPresent(join(directory, 'package.json')) || dirname(directory) === directory) return;
            directory = dirname(directory);
        }
    } catch (error) {
        const issue = error as { code?: string; path?: string } | undefined;
        if (error instanceof AOTUIError || issue?.code === 'APP_AUTHORING_PROTOCOL_UNSUPPORTED') throw error;
        if (issue?.code === 'APP_METADATA_INVALID' && issue.path) location += '#' + issue.path;
        throw new AOTUIError('APP_MANIFEST_INVALID', { path: location,
            reason: error instanceof Error ? error.message : 'Build the App to generate aoapp.json' });
    }
}

export async function readAppManifest(localPath: string): Promise<AppManifest> {
    const target = localTarget(localPath);
    const manifest = findAppManifest(target);
    if (!manifest) throw new AOTUIError('APP_MANIFEST_INVALID', { path: target, reason: 'Provide a local App with a generated aoapp.json' });
    return manifest;
}

export function resolveAppModule(modulePath: string, expected?: string): AppManifest {
    const target = localTarget(modulePath);
    const manifest = findAppManifest(target);
    if (manifest) {
        if (expected !== undefined && manifest.metadata.app_name !== expected) throw new AOTUIError('APP_IDENTITY_MISMATCH', {
            expected: manifest.metadata.app_name, actual: expected, path: 'options.name',
        });
        return manifest;
    }
    if (expected === undefined) throw new AOTUIError('APP_MANIFEST_INVALID', { path: target,
        reason: 'Provide a generated aoapp.json or the bare module’s app_name as options.name' });
    return { metadata: captureAppMetadata({ app_name: expected }), modulePath };
}
