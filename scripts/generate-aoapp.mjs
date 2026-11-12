import { isTUIAppFactory, hasViewTypeToolAuthoringProtocol, captureAppMetadata } from '@aotui/runtime/spi';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

async function loadBuiltModule(appDir, main) {
  const entryPath = path.resolve(appDir, main);
  return import(`${pathToFileURL(entryPath).href}?t=${Date.now()}`);
}

export async function buildAoappManifest(appDir) {
  const pkg = await readJson(path.join(appDir, 'package.json'));
  const main = pkg.main ?? './dist/index.js';
  if (!isNonEmptyString(main)) throw Object.assign(new TypeError('package.json main must name the built App entry'), { code: 'APP_MANIFEST_INVALID' });
  const moduleNamespace = await loadBuiltModule(appDir, main);

  const factory = moduleNamespace.default;
  if (!isTUIAppFactory(factory)) throw Object.assign(new TypeError('Built app must export a managed createApp or createTUIApp factory'), { code: 'APP_INVALID_EXPORT' });
  if (!hasViewTypeToolAuthoringProtocol(factory)) throw Object.assign(new TypeError('Build with the matching SDK authoring contract'), { code: 'APP_AUTHORING_PROTOCOL_UNSUPPORTED' });
  const kernelConfig = factory.kernelConfig;
  const metadata = captureAppMetadata({ app_name: kernelConfig.appName,
    ...((kernelConfig.description ?? pkg.description) === undefined ? {} : { description: kernelConfig.description ?? pkg.description }),
    ...(kernelConfig.whatItIs === undefined ? {} : { whatItIs: kernelConfig.whatItIs }),
    ...(kernelConfig.whenToUse === undefined ? {} : { whenToUse: kernelConfig.whenToUse }),
  });

  const result = {
    ...metadata,
    toolAuthoringProtocol: Object.getOwnPropertyDescriptor(factory, 'toolAuthoringProtocol')?.value,
    persistenceSupport: Object.getOwnPropertyDescriptor(factory, 'persistenceSupport')?.value,
    appLifecycleSupport: Object.getOwnPropertyDescriptor(factory, 'appLifecycleSupport')?.value,
    version: pkg.version ?? '0.1.0',
    author: pkg.author,
    license: pkg.license,
    entry: {
      main,
      types: pkg.types,
    },
  };

  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined)
  );
}

export async function writeAoappManifest(appDir, manifest) {
  const manifestPath = path.join(appDir, 'aoapp.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return manifestPath;
}

async function main() {
  const appDir = process.argv[2];
  if (!isNonEmptyString(appDir)) {
    throw new Error('Usage: node scripts/generate-aoapp.mjs <app-dir>');
  }

  const absoluteAppDir = path.resolve(process.cwd(), appDir);
  const manifest = await buildAoappManifest(absoluteAppDir);
  await writeAoappManifest(absoluteAppDir, manifest);
  console.log(`[generate-aoapp] Wrote ${path.join(absoluteAppDir, 'aoapp.json')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[generate-aoapp] ${error.message}`);
    process.exit(1);
  });
}
