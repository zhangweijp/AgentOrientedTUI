// Temporary, exact-source TypeScript 7.0.2 LSP backport. Remove with the upstream fix.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const toolchain = path.join(root, 'toolchain');
const profileBytes = await fs.readFile(path.join(toolchain, 'native-lsp.json'));
const profile = JSON.parse(profileBytes);
if (process.platform !== profile.platform || process.arch !== profile.arch)
  throw Error(`Native LSP candidate supports ${profile.platform}-${profile.arch}; this platform is unverified.`);
const output = path.join(root, 'native-lsp');
const binary = path.join(output, 'tsgo');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = path.join(toolchain, 'typescript-7.0.2-build-inputs.tar.gz');
const patch = path.join(toolchain, 'shutdown-exit-64894.patch');
if (sha(await fs.readFile(archive)) !== profile.sourceArchiveSHA256 || sha(await fs.readFile(patch)) !== profile.patchSHA256)
  throw Error('Native LSP build input hash mismatch.');
let ready = false;
try {
  ready = sha(await fs.readFile(binary)) === profile.binarySHA256 &&
    (await fs.readFile(path.join(output, 'profile.json'))).equals(profileBytes);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (ready) {
  console.log('Native LSP verified:', profile.typescriptVersion, profile.binarySHA256);
} else {
  const cache = path.join(root, 'node_modules', '.cache', 'aotui-native-lsp');
  await fs.mkdir(cache, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cache, 'build-'));
  const env = { ...process.env, GOTOOLCHAIN: 'local', GOCACHE: process.env.GOCACHE ?? path.join(cache, 'go-cache'),
    GOPATH: process.env.GOPATH ?? path.join(cache, 'go-path'), GOMODCACHE: process.env.GOMODCACHE ?? path.join(cache, 'go-modcache') };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: temporary, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`${command} failed: code ${result.status}, signal ${result.signal}`);
  };
  try {
    const goVersion = spawnSync('go', ['version'], { encoding: 'utf8', env });
    if (goVersion.error) throw goVersion.error;
    if (goVersion.status !== 0 || !goVersion.stdout.includes(` ${profile.goVersion} ${profile.platform}/${profile.arch}`))
      throw Error(`Source build requires ${profile.goVersion} ${profile.platform}/${profile.arch}. Installed App tar consumers do not need Go.`);
    run('tar', ['-xzf', archive, '-C', temporary]);
    run('patch', ['--batch', '-p1', '-i', patch]);
    const built = path.join(temporary, 'tsgo');
    run('go', ['build', '-trimpath', '-buildvcs=false', '-o', built, './cmd/tsgo']);
    if (sha(await fs.readFile(built)) !== profile.binarySHA256) throw Error('Native LSP output differs from the qualified binary.');
    await fs.mkdir(output, { recursive: true });
    await fs.copyFile(built, binary + '.next'); await fs.chmod(binary + '.next', 0o755); await fs.rename(binary + '.next', binary);
    await fs.writeFile(path.join(output, 'profile.json.next'), profileBytes);
    await fs.rename(path.join(output, 'profile.json.next'), path.join(output, 'profile.json'));
    console.log('Native LSP prepared:', profile.typescriptVersion, profile.binarySHA256);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
