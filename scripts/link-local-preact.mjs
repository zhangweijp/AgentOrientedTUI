import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultSDK = fileURLToPath(new URL('../sdk/', import.meta.url));

// Local SDK symlinks bypass the consumer's peer dependency resolution. Share the
// entire Preact package so renderer, Hooks and JSX entry points use one instance.
export function linkLocalPreact(consumerDirectory, sdkDirectory = defaultSDK) {
  const manifest = JSON.parse(readFileSync(join(consumerDirectory, 'package.json'), 'utf8'));
  const declaresPreact = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .some(field => Object.hasOwn(manifest[field] ?? {}, 'preact'));
  if (!declaresPreact) return;

  // Resolve the source before changing the consumer's existing installation.
  const source = realpathSync(join(sdkDirectory, 'node_modules/preact'));
  const destination = join(consumerDirectory, 'node_modules/preact');
  try {
    if (realpathSync(destination) === source) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  mkdirSync(dirname(destination), { recursive: true });
  const linkTarget = relative(realpathSync(dirname(destination)), source);
  rmSync(destination, { recursive: true, force: true });
  symlinkSync(linkTarget, destination, 'dir');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/link-local-preact.mjs <consumer-directory>');
  linkLocalPreact(resolve(process.argv[2]));
}
