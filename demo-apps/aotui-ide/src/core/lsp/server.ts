import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { requireIDE } from '../ide-errors.js';

export async function spawnLSPServer(root: string, command: string, args: string[], extraEnv: Record<string, string> = {}): Promise<LSPServer.Handle> {
  const bins = [path.join(root, 'node_modules/.bin'), fileURLToPath(new URL('../../../node_modules/.bin/', import.meta.url))];
  const proc = spawn(command, args, { cwd: root, detached: process.platform !== 'win32', env: { ...process.env, ...extraEnv,
    PATH: [...bins, extraEnv.PATH ?? process.env.PATH ?? ''].join(path.delimiter) } });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { proc.off('spawn', ready); reject(error); };
    const ready = () => { proc.off('error', failed); resolve(); };
    proc.once('error', failed); proc.once('spawn', ready);
  });
  return { process: proc, processGroup: process.platform !== 'win32' ? proc.pid : undefined };
}

export namespace LSPServer {

  export interface Handle {
    process: ChildProcessWithoutNullStreams
    processGroup?: number
    /** Only the pinned, exercised server profile may certify group cleanup. */
    processGroupVerified?: boolean
    initialization?: Record<string, any>
  }

  export interface Info {
    id: string
    extensions: string[]
    spawn(root: string): Promise<Handle | undefined>
  }

  // =========================================================
  // Language Server Definitions
  // =========================================================

  // TypeScript / JavaScript
  export const Typescript: Info = {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    async spawn(root) {
      requireIDE(process.platform === 'darwin' && process.arch === 'arm64', 'LSP_NATIVE_PLATFORM_UNSUPPORTED');
      const directory = new URL('../../../native-lsp/', import.meta.url);
      const profile = JSON.parse(await fs.readFile(new URL('profile.json', directory), 'utf8'));
      const expected = JSON.parse(await fs.readFile(new URL('../../../toolchain/native-lsp.json', import.meta.url), 'utf8'));
      requireIDE(JSON.stringify(profile) === JSON.stringify(expected), 'LSP_NATIVE_PROFILE_MISMATCH');
      const executable = fileURLToPath(new URL('tsgo', directory));
      requireIDE(createHash('sha256').update(await fs.readFile(executable)).digest('hex') === expected.binarySHA256, 'LSP_NATIVE_BINARY_MISMATCH');
      const handle = await spawnLSPServer(root, executable, ['--lsp', '--stdio']);
      if (handle) handle.processGroupVerified = true;
      return handle;
    },
  }

  // Python (Pyright)
  export const Pyright: Info = {
    id: "pyright",
    extensions: [".py", ".pyi"],
    async spawn(root) {
      return spawnLSPServer(root, "pyright-langserver", ["--stdio"]);
    }
  }

  // Go (gopls)
  export const Go: Info = {
    id: "gopls",
    extensions: [".go"],
    async spawn(root) {
      return spawnLSPServer(root, "gopls", ["serve"]);
    }
  }

  // Rust (rust-analyzer)
  export const Rust: Info = {
    id: "rust-analyzer",
    extensions: [".rs"],
    async spawn(root) {
      return spawnLSPServer(root, "rust-analyzer", []);
    }
  }

  // C/C++ (clangd)
  export const Clangd: Info = {
    id: "clangd",
    extensions: [".c", ".cpp", ".objc", ".objcpp", ".cc", ".h", ".hpp"],
    async spawn(root) {
      return spawnLSPServer(root, "clangd", []);
    }
  }

  // JSON and HTML servers are not included to align with opencode
  // These provide limited value for LLM-assisted development
  // If needed, users can configure custom LSP servers via config file
}
