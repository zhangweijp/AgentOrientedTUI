import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

async function loadBuiltModule(appDir) {
  const entryPath = path.join(appDir, 'dist', 'index.js');
  return import(`${pathToFileURL(entryPath).href}?t=${Date.now()}`);
}

function resolveCanonicalAppName(factory) {
  if (typeof factory !== 'object' || factory === null || Array.isArray(factory)) {
    throw new Error('Built app must export the createTUIApp component factory');
  }

  const factoryFields = Object.getOwnPropertyDescriptors(factory);
  const displayName = factoryFields.displayName;
  const kernelConfig = factoryFields.kernelConfig;
  const initializeComponent = factoryFields.initializeComponent;
  if (!displayName || !('value' in displayName) || typeof displayName.value !== 'string' || displayName.value.length === 0 ||
      !kernelConfig || !('value' in kernelConfig) || typeof kernelConfig.value !== 'object' ||
      kernelConfig.value === null || Array.isArray(kernelConfig.value) ||
      !initializeComponent || !('value' in initializeComponent) || typeof initializeComponent.value !== 'function') {
    throw new Error('Built app must export the createTUIApp component factory');
  }

  const appNameField = Object.getOwnPropertyDescriptor(kernelConfig.value, 'appName');
  const appName = appNameField && 'value' in appNameField ? appNameField.value : undefined;

  if (!isNonEmptyString(appName)) {
    throw new Error('Unable to resolve app_name from built app metadata');
  }

  return appName;
}

export async function buildAoappManifest(appDir) {
  const [pkg, moduleNamespace] = await Promise.all([
    readJson(path.join(appDir, 'package.json')),
    loadBuiltModule(appDir),
  ]);

  const factory = moduleNamespace.default;
  const appName = resolveCanonicalAppName(factory);
  const kernelConfig = factory?.kernelConfig ?? {};

  const result = {
    app_name: appName,
    version: pkg.version ?? '0.1.0',
    description: kernelConfig.description ?? pkg.description,
    whatItIs: kernelConfig.whatItIs,
    whenToUse: kernelConfig.whenToUse,
    author: pkg.author,
    license: pkg.license,
    entry: {
      main: pkg.main ?? './dist/index.js',
      types: pkg.types,
    },
    promptRole: kernelConfig.promptRole,
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
