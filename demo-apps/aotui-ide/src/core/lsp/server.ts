import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import path from "path"
import { Log, Instance } from "./adapters.js"
import fs from "fs/promises"
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
  const log = Log.create({ service: "lsp.server" })

  export interface Handle {
    process: ChildProcessWithoutNullStreams
    processGroup?: number
    /** Only the pinned, exercised server profile may certify group cleanup. */
    processGroupVerified?: boolean
    initialization?: Record<string, any>
  }

  type RootFunction = (file: string) => Promise<string | undefined>

  // Helper to find nearest root containing specific files
  const NearestRoot = (includePatterns: string[]): RootFunction => {
    return async (file) => {
      let current = path.dirname(file)
      const stop = Instance.directory

      while (true) {
        for (const pattern of includePatterns) {
          try {
            await fs.access(path.join(current, pattern))
            return current
          } catch { }
        }

        if (current === stop || current === path.dirname(current)) {
          return Instance.directory
        }
        current = path.dirname(current)
      }
    }
  }

  export interface Info {
    id: string
    extensions: string[]
    global?: boolean
    root: RootFunction
    spawn(root: string): Promise<Handle | undefined>
    initialization?: Record<string, any>
  }

  // =========================================================
  // Generic Spawn Helper
  // =========================================================

  async function spawnServer(root: string, command: string, args: string[]): Promise<Handle | undefined> {
    return spawnLSPServer(root, command, args);
  }

  // =========================================================
  // Language Server Definitions
  // =========================================================

  // TypeScript / JavaScript
  export const Typescript: Info = {
    id: "typescript",
    root: NearestRoot(
      ["package.json", "tsconfig.json", "jsconfig.json"]
    ),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    async spawn(root) {
      let command = 'typescript-language-server', args = ['--stdio'];
      let processGroupVerified = false;
      try {
        const packageFile = createRequire(import.meta.url).resolve('typescript-language-server/package.json');
        const manifest = JSON.parse(await fs.readFile(packageFile, 'utf8'));
        const typescript = JSON.parse(await fs.readFile(createRequire(packageFile).resolve('typescript/package.json'), 'utf8'));
        processGroupVerified = process.platform !== 'win32' && manifest.version === '5.1.3' && typescript.version === '5.9.3';
        command = process.execPath; args = [path.join(path.dirname(packageFile), manifest.bin['typescript-language-server']), '--stdio'];
      } catch { /* A separately installed server can still be resolved on PATH. */ }
      return spawnServer(root, command, args)
        .then(handle => {
          if (handle) {
            handle.processGroupVerified = processGroupVerified;
            handle.initialization = {
              preferences: {
                includeInlayParameterNameHints: 'all',
                includeInlayFunctionParameterTypeHints: true,
                includeInlayVariableTypeHints: true
              }
            };
          }
          return handle;
        });
    },
  }

  // Python (Pyright)
  export const Pyright: Info = {
    id: "pyright",
    root: NearestRoot(
      ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt"]
    ),
    extensions: [".py", ".pyi"],
    async spawn(root) {
      return spawnServer(root, "pyright-langserver", ["--stdio"]);
    }
  }

  // Go (gopls)
  export const Go: Info = {
    id: "gopls",
    root: NearestRoot(["go.mod", "go.work"]),
    extensions: [".go"],
    async spawn(root) {
      return spawnServer(root, "gopls", ["serve"]);
    }
  }

  // Rust (rust-analyzer)
  export const Rust: Info = {
    id: "rust-analyzer",
    root: NearestRoot(["Cargo.toml"]),
    extensions: [".rs"],
    async spawn(root) {
      return spawnServer(root, "rust-analyzer", []);
    }
  }

  // C/C++ (clangd)
  export const Clangd: Info = {
    id: "clangd",
    root: NearestRoot(["compile_commands.json", "compile_flags.txt", ".clang-format"]),
    extensions: [".c", ".cpp", ".objc", ".objcpp", ".cc", ".h", ".hpp"],
    async spawn(root) {
      return spawnServer(root, "clangd", []);
    }
  }

  // JSON and HTML servers are not included to align with opencode
  // These provide limited value for LLM-assisted development
  // If needed, users can configure custom LSP servers via config file
}
