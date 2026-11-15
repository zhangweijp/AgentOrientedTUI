#!/usr/bin/env node
import { buildViewMessageMarkup } from '@aotui/runtime/adapters';

/**
 * agentina CLI - Third-Party App Management
 * 
 * 命令:
 *   agentina install <source> 安装 App (local/npm)
 *   agentina search [query]   搜索可安装 App
 *   agentina remove <name>    卸载 App
 *   agentina list             列出已安装
 *   agentina enable <name>    启用 App
 *   agentina disable <name>   禁用 App
 *   agentina autostart <name> <on|off>  设置自动启动
 *   agentina run [name]       Run installed apps (or specific app)
 * 
 * @module @aotui/cli
 */

import { AppRegistry, createRuntime, type AppID } from '@aotui/runtime';
import * as readline from 'readline';
import fs from 'fs';
import { installNpmPackage, removeInstalledApp } from './npm-installer.js';
import { searchCatalog } from './catalog.js';
import { parseInstallSource, type ParsedInstallSource } from './sources.js';
import { resolveCatalog, resolveCatalogOptionsFromConfig } from './catalog-resolver.js';
import { renderInstalledAppLines } from './cli-list.js';

const HELP = `
Agentina App Manager

Usage: agentina <command> [options]

Commands:
  install <source>     Install app from local path or npm package
  search [query]       Search installable apps from catalog
  remove <name>        Uninstall an app
  list                 List installed apps
  enable <name>        Enable an app
  disable <name>       Disable an app
  autostart <name> <on|off>  Set auto-start behavior
  run [name]           Run installed apps (or specific app)

Options:
  --force              Force install (overwrite existing, reinstall when needed)
  --no-autostart       Install without auto-start
  --help               Show help

Examples:
  agentina install .                          # Install from local directory
  agentina install local:./my-app             # Install from an explicit local path
  agentina install @scope/aotui-weather      # Install from npm
  agentina search weather                     # Search catalog
  agentina list                               # Show all installed apps
  agentina run my-app                         # Run a specific app
`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log(HELP);
        return;
    }

    const command = args[0];
    const registry = new AppRegistry();
    for (const result of await registry.loadFromConfig()) {
        if (result.status === 'failed') console.error(`[TUI] Could not discover ${result.name}`, result.issue);
    }

    try {
        switch (command) {
            case 'install':
                await handleInstall(registry, args.slice(1));
                break;

            case 'search':
                await handleSearch(registry, args.slice(1));
                break;

            case 'remove':
                await handleRemove(registry, args.slice(1));
                break;

            case 'list':
                handleList(registry);
                break;

            case 'enable':
                await handleEnable(registry, args.slice(1), true);
                break;

            case 'disable':
                await handleEnable(registry, args.slice(1), false);
                break;

            case 'autostart':
                await handleAutoStart(registry, args.slice(1));
                break;

            case 'run':
                await handleRun(registry, args.slice(1));
                break;

            default:
                console.error(`Unknown command: ${command}`);
                console.log(HELP);
                process.exit(1);
        }
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// ════════════════════════════════════════════════════════════════
//  Command Handlers
// ════════════════════════════════════════════════════════════════

interface ParsedInstallArgs {
    source: string;
    force: boolean;
    autoStart: boolean;
}

function parseInstallArgs(args: string[]): ParsedInstallArgs {
    let force = false;
    let autoStart = true;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === '--force') {
            force = true;
            continue;
        }
        if (token === '--no-autostart') {
            autoStart = false;
            continue;
        }
        if (token.startsWith('--')) {
            throw new Error(`Unknown option: ${token}`);
        }
        positional.push(token);
    }

    if (positional.length === 0) {
        throw new Error('Usage: agentina install <source> [--force] [--no-autostart]');
    }

    return {
        source: positional[0],
        force,
        autoStart
    };
}

async function handleSearch(registry: AppRegistry, args: string[]): Promise<void> {
    const query = args[0];
    const resolvedCatalog = await resolveCatalog(resolveCatalogOptionsFromConfig(registry.getConfig().catalog));
    const results = searchCatalog(query, resolvedCatalog.catalog);

    if (results.length === 0) {
        console.log(query ? `No app found for "${query}".` : 'No app found in catalog.');
        return;
    }

    console.log(query ? `Catalog search results for "${query}":` : 'Catalog apps:');
    console.log(`Source: ${resolvedCatalog.source}${resolvedCatalog.remoteUrl ? ` (${resolvedCatalog.remoteUrl})` : ''}`);
    if (resolvedCatalog.signatureVerified) {
        console.log('Trust: signed catalog verified');
    }
    for (const warning of resolvedCatalog.warnings) {
        console.log(`Warning: ${warning}`);
    }
    console.log('');

    for (const app of results) {
        console.log(`- ${app.name} (${app.id})`);
        console.log(`  Package: ${app.packageName}@${app.latestVersion}`);
        console.log(`  Description: ${app.description}`);
        console.log(`  Install: agentina install ${app.packageName}`);
        console.log('');
    }
}

async function handleInstall(registry: AppRegistry, args: string[]): Promise<void> {
    const parsed = parseInstallArgs(args);
    const resolvedSource = parseInstallSource(parsed.source);

    const name = await installAppFromSource(registry, resolvedSource, parsed);
    if (resolvedSource.kind === 'local') {
        console.log(`✅ Successfully linked local app: ${name}`);
        return;
    }
    console.log(`✅ Successfully installed npm app: ${name}`);
}

async function installAppFromSource(
    registry: AppRegistry,
    source: ParsedInstallSource,
    options: ParsedInstallArgs
): Promise<string> {
    if (source.kind === 'local') {
        if (!fs.existsSync(source.absolutePath)) {
            throw new Error(`Local path does not exist: ${source.absolutePath}`);
        }

        console.log(`Linking ${source.absolutePath}...`);
        return registry.add(source.source, {
            force: options.force,
            autoStart: options.autoStart,
            originalSource: source.source,
            distribution: {
                type: 'local',
                installedPath: source.absolutePath,
                installedAt: new Date().toISOString()
            }
        });
    }

    console.log(`Installing ${source.packageSpec} from npm...`);
    const result = await installNpmPackage(source.packageSpec, {
        forceReinstall: options.force
    });

    return registry.add(result.localSource, {
        force: options.force,
        autoStart: options.autoStart,
        originalSource: source.source,
        distribution: {
            type: 'npm',
            packageName: result.packageName,
            requested: result.packageSpec,
            resolvedVersion: result.resolvedVersion ?? undefined,
            installRoot: result.installRoot,
            installedPath: result.installedPath,
            installedAt: new Date().toISOString()
        }
    });
}

async function handleRemove(registry: AppRegistry, args: string[]): Promise<void> {
    if (args.length === 0) {
        console.error('Usage: agentina remove <name>');
        process.exit(1);
    }

    const name = args[0];
    await removeInstalledApp(registry, name);
    console.log(`✅ Successfully removed: ${name}`);
}

function handleList(registry: AppRegistry): void {
    const config = registry.getConfig();
    for (const line of renderInstalledAppLines(config, registry)) {
        console.log(line);
    }
}

async function handleEnable(registry: AppRegistry, args: string[], enable: boolean): Promise<void> {
    if (args.length === 0) {
        console.error(`Usage: agentina ${enable ? 'enable' : 'disable'} <name>`);
        process.exit(1);
    }

    const name = args[0];
    await registry.setEnabled(name, enable);
    console.log(`✅ ${enable ? 'Enabled' : 'Disabled'}: ${name}`);
}

/**
 * [RFC-014] Handle autostart command
 */
async function handleAutoStart(registry: AppRegistry, args: string[]): Promise<void> {
    if (args.length < 2) {
        console.error('Usage: agentina autostart <name> <on|off>');
        process.exit(1);
    }

    const name = args[0];
    const value = args[1].toLowerCase();

    if (value !== 'on' && value !== 'off') {
        console.error('Value must be "on" or "off"');
        process.exit(1);
    }

    await registry.setAutoStart(name, value === 'on');
    console.log(`✅ Auto-start ${value === 'on' ? 'enabled' : 'disabled'}: ${name}`);
}

async function handleRun(registry: AppRegistry, args: string[]): Promise<void> {
    const targetApp = args[0]; // Optional: run specific app

    console.log('[TUI] Starting Runtime...');
    const runtime = createRuntime();
    const desktopId = await runtime.createDesktop();
    const desktop = runtime.getDesktop(desktopId);

    console.log(`[TUI] Desktop created: ${desktopId}`);

    // [Fix] Move rl creation before signal subscription so callback can use it
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'tui> '
    });

    let isInteractive = false;
    async function printCurrentViews(): Promise<void> {
        for (const app of desktop.getInstalledApps()) {
            if (app.status !== 'running' || !app.appInstanceId) continue;
            const appId = String(app.appId);
            const access = runtime.getAppInteraction(desktopId, appId, app.appInstanceId);
            const result = access.status === 'ready' ? await access.interaction.preview() : access;
            if (result.status !== 'previewed') {
                console.error(`[TUI] Could not preview ${appId}: ${result.issue.code} ${result.issue.message}`);
                continue;
            }
            console.log(`--- App ${appId} ---`);
            for (const view of result.views) {
                if (!view.content) continue;
                console.log(buildViewMessageMarkup({ appId, appName: app.name || appId,
                    viewId: view.id, viewType: view.type, kind: view.kind, viewName: view.name,
                    markup: view.content.value }));
            }
        }
    }

    let stopping: Promise<void> | undefined;
    function stop(): Promise<void> {
        if (!stopping) {
            stopping = runtime.beginShutdown().completion.then(report => {
                if (!report.ok || !report.resourcesReleased) process.exitCode = 1;
            });
            rl.close();
        }
        return stopping;
    }
    rl.on('close', () => { void stop().catch(error => { process.exitCode = 1;console.error('[TUI] Shutdown failed:', error); }); });

    desktop.output.subscribe(() => {
        if (!isInteractive) return;
        void printCurrentViews().then(() => rl.prompt(true)).catch(error => console.error('[TUI] Observation failed:', error));
    });

    // Install apps from registry
    const config = registry.getConfig();
    const appsToRun = targetApp ? [targetApp] : Object.keys(config.apps);

    const runningAppIds: string[] = [];

    for (const name of appsToRun) {
        const entry = config.apps[name];
        if (!entry) {
            console.error(`App "${name}" not found in registry.`);
            continue;
        }
        if (!entry.enabled && !targetApp) {
            continue;
        }

        const loadedApp = registry.get(name);
        if (!loadedApp) {
             console.error(`App "${name}" could not be loaded (check if enabled or valid source).`);
             continue;
        }

        console.log(`[TUI] Installing ${name} from ${loadedApp.modulePath}...`);

        try {
            const appId = await runtime.installDynamicWorkerApp(desktopId, loadedApp.modulePath, {
                name: name,
                config: {} // TODO: support config injection
            });
            runningAppIds.push(appId);
            console.log(`[TUI] Started ${name} (AppID: ${appId})`);
            
            // Auto open
            await desktop.openApp(appId as AppID);
        } catch (e: any) {
            console.error(`[TUI] Failed to start ${name}: ${e.message}`);
        }
    }

    if (runningAppIds.length === 0) {
        console.log('[TUI] No apps started.');
        await stop();
        return;
    }

    console.log('[TUI] Runtime ready. Type "snapshot" to show current views, or "exit" to quit.');

    isInteractive = true;
    rl.prompt();

    rl.on('line', async (line: string) => {
        const input = line.trim();
        if (input === 'exit') {
            await stop();
            return;
        }

        if (input === 'snapshot') await printCurrentViews();
        rl.prompt();
    });
}

// Run
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
