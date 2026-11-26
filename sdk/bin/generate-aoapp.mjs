#!/usr/bin/env node
import { APP_LIFECYCLE_PROTOCOL, VIEW_TYPE_TOOL_PROTOCOL, captureAppMetadata } from '@aotui/core';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function invalid(field, reason) {
  return Object.assign(new TypeError(`package.json ${field}: ${reason}`), { code: 'APP_MANIFEST_INVALID', path: field });
}

export async function buildAoappManifest(appDir) {
  const pkg = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  if (!pkg?.aotui || typeof pkg.aotui !== 'object' || Array.isArray(pkg.aotui))
    throw invalid('aotui', 'Declare the App metadata in an object');
  const { app_name, whatItIs, whenToUse } = pkg.aotui;
  const { description, version, main, types } = pkg;
  if (typeof version !== 'string' || !version.trim()) throw invalid('version', 'Provide a version');
  const metadata = captureAppMetadata({ app_name,
    ...(description === undefined ? {} : { description }),
    ...(whatItIs === undefined ? {} : { whatItIs }),
    ...(whenToUse === undefined ? {} : { whenToUse }),
  });
  for (const [field, file] of [['main', main], ...(types === undefined ? [] : [['types', types]])]) {
    if (!isNonEmptyString(file) || !file.trim() || !await stat(path.resolve(appDir, file)).then(info => info.isFile(), () => false))
      throw invalid(field, 'Name an existing built file');
  }
  return {
    ...metadata,
    version,
    entry: { main, ...(types === undefined ? {} : { types }) },
    toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL,
    appLifecycleSupport: APP_LIFECYCLE_PROTOCOL,
  };
}

export async function writeAoappManifest(appDir, manifest) {
  const manifestPath = path.join(appDir, 'aoapp.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return manifestPath;
}

async function main() {
  const appDir = process.argv[2];
  if (!isNonEmptyString(appDir)) {
    throw new Error('Usage: generate-aoapp <app-dir>');
  }

  const absoluteAppDir = path.resolve(process.cwd(), appDir);
  const manifest = await buildAoappManifest(absoluteAppDir);
  await writeAoappManifest(absoluteAppDir, manifest);
  console.log(`[generate-aoapp] Wrote ${path.join(absoluteAppDir, 'aoapp.json')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[generate-aoapp] ${error.code ? error.code + ' ' : ''}${error.message}`);
    process.exit(1);
  });
}
