# AOTUI Repository Guide

> Experimental project. This repository is for research, prototyping, and internal exploration. It is not production-ready and should not be used as-is in production environments.

`GUIDE.md` is the functional companion to [README.md](./README.md).

- `README.md` explains the idea and the interface model.
- `GUIDE.md` explains the repository layout, architecture, stack, and local development flow.

Build with the SDK and run the App through a managed Worker. [SDK README](sdk/README.md) · [Runtime README](runtime/README.md)

For Host integration and Semantic Source, see the [Runtime package guide](runtime/README.md). For the portable interaction rules, see the [Core package guide](core/README.md).

## Repository At A Glance

The main stack is:

```txt
App -> SDK -> Core <- Runtime <- Host
Host -> Agent Driver
Host -> Driver Adapter -> Core
```

- `host/` is the desktop product shell. It owns the GUI, App distribution, and the `agentina` CLI.
- `core/` defines shared projection, observation, Ref, and Tool invocation contracts.
- `runtime/` resolves and manages App instances, Workers, and Host-facing observations.
- `sdk/` is the app authoring layer used to build AOTUI apps.
- `agent-driver-v2/` is the model execution and tool orchestration layer used by the Host.
- `demo-apps/` contains apps that exercise the SDK/runtime stack inside the host.

Dependency direction in the codebase is:

- `runtime` can be consumed independently of `agent-driver-v2`
- `sdk`, `runtime`, and `agent-driver-adapter` depend on `core`
- `host` depends on `agent-driver-v2`, `agent-driver-adapter`, `runtime`, and `sdk`
- App authoring uses `sdk` and the peers required by the chosen authoring entry

Manual build order:

```txt
core -> sdk / runtime
agent-driver-v2 + runtime + core -> agent-driver-adapter
sdk -> demo-apps
agent-driver-adapter + runtime -> host
```

## Top-Level Folders

| Folder | What it is for |
| --- | --- |
| `agent-driver-v2/` | LLM execution layer: provider setup, streaming, message aggregation, and tool-call orchestration. |
| `core/` | Portable projection, snapshot, Ref, observation, and Tool invocation semantics. |
| `runtime/` | Installed App instances, Workers, Desktop lifecycle, and View exposure. |
| `sdk/` | Author API for TypeScript and Preact, including View types, Refs, and Tools. |
| `host/` | Electron desktop shell, web UI, local services, App catalog, npm installs, and the `agentina` CLI. |
| `demo-apps/` | Reference apps that run on the stack. The setup scripts auto-install `aotui-ide`, `planning-app`, `terminal-app`, and `lite-browser-app` by default. |
| `scripts/` | Repo-level helper scripts for builds, verification, and local release. |
| `resource/` | Static assets used by the project. |

Use `pnpm -C <folder> …` for individual sibling packages. The root provides `pnpm release:local` and `pnpm test:adapter-integration`.

## Architecture

### Layered View

1. **Host**
   The Electron application and GUI that users interact with locally. The Host and CLI share App catalog resolution, npm installation, and managed package cleanup.
2. **Runtime**
   The execution layer owns the installed App instances and Worker lifecycle.
3. **Core**
   Defines the projection, observation, Ref and invocation rules shared across authoring and execution.
4. **SDK**
   The app authoring model. It provides `createTUIApp()`, component primitives, hooks, refs, and typed Tools for building agent-facing apps.
5. **Apps**
   Concrete system or demo apps built with the SDK and executed through the runtime/host stack.
6. **Agent Driver**
   A shared execution subsystem that handles provider selection, prompt/message preparation, streaming, and tool orchestration for model-driven behavior.

### Responsibility Boundaries

- `agent-driver-v2/`: model loop, provider wiring, streaming, tool dispatch
- `core/`: application and host implementation contracts for projection and calls
- `runtime/` handles app lifecycle, Workers, View exposure, and adapters
- `sdk/`: app-authoring APIs and ergonomics
- `host/` handles the Electron shell, GUI, IPC, CLI, App distribution, and local services
- `demo-apps/`: app behavior built on the shared stack

### Key Entry Points

- Agent driver: `agent-driver-v2/src/core/agent-driver-v2.ts`, `agent-driver-v2/src/core/llm-client.ts`
- Runtime: `runtime/src/facades/facades.ts`, `runtime/src/kernel/index.ts`
- SDK: `sdk/src/app-factory/createTUIApp.ts`, `sdk/src/components/View.tsx`
- Host: `host/src/`
- Agentina CLI and App distribution: `host/src/app-distribution/`
- App manifests: `sdk/bin/generate-aoapp.mjs`, shipped as the SDK's `generate-aoapp` command

## Tech Stack

Core stack:

- **Language**: TypeScript across the core packages and apps
- **Package management**: `pnpm`
- **Runtime / platform**: Node.js, Electron, Worker Threads
- **UI**:
  - `host/` uses React 19, Vite, Tailwind CSS 4, and related UI libraries
  - `sdk/` and app-side authoring center on Preact
- **Agent / model integration**: Vercel AI SDK (`ai`) and provider packages such as `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/xai`
- **App Tool and Ref schemas** use TypeBox and JSON Schema.
- **Testing**: `vitest` across most packages; `demo-apps/aotui-ide` currently uses `jest`
- **Build tooling**: `tsc`, Vite, `electron-builder`
- **DOM simulation / rendering helpers**: `linkedom`, `happy-dom`, `preact-render-to-string`
- **CLI / app distribution helpers**: `agentina`, `npm link`, and generated `aoapp.json` manifests

### Stack By Layer

| Layer | Main technologies |
| --- | --- |
| `host/` | Electron, React 19, Vite, Tailwind CSS 4, TRPC, Express, SQLite-related tooling |
| `core/` | TypeScript, JSON Schema validation, platform-standard encoding and timers |
| `runtime/` | Node.js, Worker Threads, application and storage backends |
| `sdk/` | TypeScript, Preact, `@preact/signals`, `linkedom`, TypeBox |
| `agent-driver-v2/` | Vercel AI SDK (`ai`), native and compatible Provider routes, including xAI through the Responses adapter |
| `demo-apps/` | TypeScript + SDK-based app packages; mostly Preact-powered app definitions |

### Why This Stack Looks Like This

This stack is opinionated. It is optimized for an agent-facing desktop runtime, not for a conventional web SaaS app.

- **Electron in `host/`** keeps the product local-first. The host needs desktop integration, local persistence, app installation, and process-level control that a browser-only shell would make harder.
- **Node.js + Worker Threads in `runtime/`** separate app execution from the host shell. That matters because apps are not just UI fragments here; they are active runtime participants that expose views, refs, and Tools to the agent.
- **Preact in `sdk/` and runtime-facing app code** keeps the app model component-based without paying the full weight of a larger client framework inside worker-rendered app execution.
- **React in `host/`** is a separate choice from Preact in the app layer. The host is a conventional GUI product surface, while the SDK is an embedded app-authoring surface. They solve different problems, so the stack intentionally splits here.
- **Vercel AI SDK and provider adapters in `agent-driver-v2/`** give the project one abstraction point for multi-model support, streaming, and tool-call execution. That keeps provider churn out of the rest of the runtime.
- **TypeBox** lets App authors declare typed business parameters and Refs. Runtime validates inputs against that contract and derives the model-facing JSON Schema.

### Trade-Offs

This stack also carries real trade-offs:

- **Two UI stacks** means some conceptual overhead. React in the host and Preact in the SDK is deliberate, but it increases mental context for contributors.
- **Worker-based isolation** improves boundaries and safety, but it makes debugging, dependency wiring, and snapshot consistency harder than a single-process app model.
- **Desktop-first architecture** makes local tooling and stateful workflows easier, but it also means the system is not optimized for straightforward web deployment.
- **Provider abstraction** speeds up model experimentation, but it can hide provider-specific behavior until you are deep in debugging or tool-call edge cases.

In practice, the stack is trying to balance four goals at once:

- desktop product ergonomics
- isolated app execution
- declarative app authoring
- model/provider flexibility

That balance is why the repository looks layered rather than minimal.

## Prerequisites

You need:

- **Node.js** installed
- **pnpm** installed
- **Git** installed

Use a recent enough Node.js version to run Electron, Vite, and current TypeScript tooling.

## How To Run

### Recommended Path: Repository Scripts

Fastest path:

```bash
chmod +x setup.sh run.sh
./setup.sh
./run.sh
```

Setup installs the sibling packages using their lockfiles, builds them in dependency order, links the Host CLI, and registers the four default apps. The launcher runs setup on a fresh tree. Later launches rebuild source and start Electron. The linked JSX Apps use the SDK’s Preact instance.

## Useful Commands

### `agentina` CLI

The `@aotui/system-chat` package provides the `agentina` executable. From a checkout, build and link `host/` as in `setup.sh`. Use `snapshot` to read the current Views and `exit` to close the Desktop during an interactive run.

```bash
agentina install <source>
agentina search [query]
agentina remove <name>
agentina list
agentina enable <name>
agentina disable <name>
agentina autostart <name> <on|off>
agentina run [name]
agentina --help
```

## Common Development Paths

### I want to change model orchestration

- `agent-driver-v2/src/core/agent-driver-v2.ts`
- `agent-driver-v2/src/core/llm-client.ts`
- `agent-driver-v2/src/core/provider-factory.ts`

### I want to change runtime state, views, or app execution

- `runtime/src/adapters/semantic-aotui-driven-source.ts`
- `runtime/src/facades/facades.ts`
- `runtime/src/kernel/`
- `runtime/src/worker-runtime/`

### I want to change app authoring APIs

- `sdk/src/app-factory/createTUIApp.ts`
- `sdk/src/components/View.tsx`
- `sdk/src/hooks/`

### I want to change the desktop product

- `host/src/`

Use this layer for GUI work, desktop UX, settings, installation flow, IPC wiring, and local services.

### Desktop Host chat and configuration

Electron registers tRPC over IPC. The GUI reads Topic history through `db.getMessages` and receives live messages through `session.events`. Both carry AI SDK `ModelMessage` content. SQLite stores the current history in `messages_v2`. The Host initializes the current schema. If an earlier schema is incompatible, startup reports the database filename and leaves the file intact. Use `DB_PATH` to select a current or new database. If an individual conversation contains an unsupported tool message, the history read reports its ID. A new conversation can use the same database.

The standalone `createHostV2(port)` entry in `host/src/server/host-v2.ts` starts the HTTP server for `GET /api/health`, `POST /api/im/feishu/webhook` and `POST /api/im/feishu/webhook/:accountId`. Use the first webhook URL for the channel default Bot and append the URL-encoded account ID for a specific Bot. Electron initializes the same Host core for IPC and its configured IM channels.

**Model routing** is resolved when the Host creates a session. Desktop checks the Topic model, the Agent model, then the active configuration. IM checks the Agent model, then the active configuration. Reopen the session after changing its model. The model catalog supplies the raw Provider model ID, which the Driver sends verbatim. Custom Provider settings supply that Provider's protocol, endpoint and key. Topic and Agent selections use `provider:model` and an active configuration stores the two fields separately. [Driver configuration](./agent-driver-v2/README.md#llm-配置)

**IM settings** live under the `im` key in `~/.agentina/im.json`. Use **Settings → IM** to read or save them. The global, channel and account switches are named `enabled`. Use `groupPolicy: "disabled"` to turn off Feishu group messages. Reload the Host to apply the IM settings.

**MCP settings** live under the `mcp` key in `~/.agentina/mcp.json`. Local entries use `type: "local"`, a `command` array containing the executable and arguments, and optional `environment`. Remote entries use `type: "remote"`, an HTTP(S) `url`, and optional `headers` and `oauth`. Each server supports `enabled`, `timeout` and `disabledTools`. Use tool names exactly as the server publishes them in its own `disabledTools` list.

Use **Settings → MCP → Add Server** to configure a server or import its settings. Setup issues appear in MCP settings. Agent and Topic tool permissions use keys such as `mcp-work-search` for the `search` tool from the `work` server. Topic server switches use keys such as `server:work`. An Agent-derived Topic saves its selected servers along with its other source controls. The selection survives shutdown and reopening. Use the Topic MCP controls to change its selection.

### I want to add a new app

Use an existing `demo-apps/*` package as the template. Apps outside the default install set can be registered manually.

- export a `createTUIApp(...)` app factory from the app entry
- compile with `tsc`
- generate `aoapp.json` with `pnpm exec generate-aoapp .` after compiling the installed App
- register the app locally with `agentina install local:<path>`

## Troubleshooting

### `pnpm` is missing

```bash
npm install -g pnpm
```

### `agentina` is not found after `npm link`

Reload your shell config or open a new terminal:

```bash
source ~/.zshrc
```

### A build fails after changing shared packages

Rebuild from the bottom of the dependency graph upward:

```bash
pnpm -C agent-driver-v2 build
pnpm -C core build
pnpm -C runtime build
pnpm -C sdk build
pnpm -C agent-driver-adapter build
pnpm -C host build
```

### A demo app does not appear in the host

Check whether it is registered:

```bash
agentina list
```

If needed, re-register it:

```bash
agentina install ./demo-apps/<app-folder> --force
```

## Further Reading

- [README.md](./README.md): project idea and interface model
- [README.zh-CN.md](./README.zh-CN.md): Chinese version of the main README
- [SDK README](sdk/README.md): define a ViewType, mount its Views, and publish raw Markdown and Refs
