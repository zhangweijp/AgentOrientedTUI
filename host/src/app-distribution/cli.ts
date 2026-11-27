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

import { createRuntime } from '@aotui/runtime';
import { AppCatalog } from './app-catalog.js';
import * as readline from 'readline';
import { searchCatalog } from './catalog.js';
import { resolveCatalog, resolveCatalogOptionsFromConfig } from './catalog-resolver.js';
import { renderInstalledAppLines } from './cli-list.js';

const HELP = `
Agentina App Manager

Usage: agentina <command> [options]

Commands:
  install <source>     Install app from local path or npm package
  search [query]       Search installable apps from catalog
  remove <name>        Uninstall an app
  list [--json]        List installed apps
  enable <name>        Enable an app
  disable <name>       Disable an app
  autostart <name> <on|off>  Set auto-start behavior
  run [name]           Run installed apps (or specific app)

Options:
  --force              Replace an existing installation after validating the candidate
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
    const catalog = new AppCatalog();

    try {
        switch (command) {
            case 'install':
                await handleInstall(catalog, args.slice(1));
                break;

            case 'search':
                await handleSearch(catalog, args.slice(1));
                break;

            case 'remove':
                await handleRemove(catalog, args.slice(1));
                break;

            case 'list':
                await handleList(catalog, args[1] === '--json');
                break;

            case 'enable':
                await handleEnable(catalog, args.slice(1), true);
                break;

            case 'disable':
                await handleEnable(catalog, args.slice(1), false);
                break;

            case 'autostart':
                await handleAutoStart(catalog, args.slice(1));
                break;

            case 'run':
                await handleRun(catalog, args.slice(1));
                break;

            default:
                console.error(`Unknown command: ${command}`);
                console.log(HELP);
                process.exit(1);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

// ════════════════════════════════════════════════════════════════
//  Command Handlers
// ════════════════════════════════════════════════════════════════

interface ParsedInstallArgs {
    source: string;
    force: boolean;
    autoStart?: boolean;
}

function parseInstallArgs(args: string[]): ParsedInstallArgs {
    let force = false;
    let autoStart: boolean | undefined;
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

async function handleSearch(catalog: AppCatalog, args: string[]): Promise<void> {
    const query = args[0];
    const resolvedCatalog = await resolveCatalog(resolveCatalogOptionsFromConfig((await catalog.getConfig()).catalog));
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

async function handleInstall(catalog: AppCatalog, args: string[]): Promise<void> {
    const parsed = parseInstallArgs(args);
    const result = await catalog.install(parsed.source, { force: parsed.force, autoStart: parsed.autoStart });
    const action = result.distributionType === 'local' ? 'linked local' : 'installed npm';
    console.log(`✅ Successfully ${action} app: ${result.name}`);
}

async function handleRemove(catalog: AppCatalog, args: string[]): Promise<void> {
    if (args.length === 0) {
        console.error('Usage: agentina remove <name>');
        process.exit(1);
    }

    const name = args[0];
    await catalog.remove(name);
    console.log(`✅ Successfully removed: ${name}`);
}

async function handleList(catalog: AppCatalog, json: boolean): Promise<void> {
    const entries = await catalog.discover();
    if (json) {
        console.log(JSON.stringify(entries));
        return;
    }
    for (const line of renderInstalledAppLines(entries)) {
        console.log(line);
    }
}

async function handleEnable(catalog: AppCatalog, args: string[], enable: boolean): Promise<void> {
    if (args.length === 0) {
        console.error(`Usage: agentina ${enable ? 'enable' : 'disable'} <name>`);
        process.exit(1);
    }

    const name = args[0];
    await catalog.setEnabled(name, enable);
    console.log(`✅ ${enable ? 'Enabled' : 'Disabled'}: ${name}`);
}

/**
 * [RFC-014] Handle autostart command
 */
async function handleAutoStart(catalog: AppCatalog, args: string[]): Promise<void> {
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

    await catalog.setAutoStart(name, value === 'on');
    console.log(`✅ Auto-start ${value === 'on' ? 'enabled' : 'disabled'}: ${name}`);
}

async function handleRun(catalog: AppCatalog, args: string[]): Promise<void> {
    const targetApp = args[0]; // Optional: run specific app

    console.log('[TUI] Starting Runtime...');
    const runtime = createRuntime();
    const desktop = await runtime.createDesktop();

    console.log(`[TUI] Desktop created: ${desktop.id}`);

    // [Fix] Move rl creation before signal subscription so callback can use it
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'tui> '
    });

    let isInteractive = false;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    async function printCurrentViews(): Promise<void> {
        for (const app of desktop.listApps()) {
            if (app.run) console.log(`--- ${app.name}: ${app.run.phase}, ${app.run.execution.resource}/${app.run.execution.channel}, projection ${app.run.projection.health}, resources ${app.run.resourcesReleased ? 'released' : 'held'} ---`);
            if (app.status !== 'running' || !app.appId || !app.appInstanceId || app.run && app.run.phase !== 'opened') continue;
            const appId = app.appId;
            const access = desktop.getRunningApp(appId, app.appInstanceId);
            const result = access.status === 'ready' ? await access.app.preview() : access;
            if (result.status !== 'previewed') {
                console.error(`[TUI] Could not preview ${appId}: ${result.issue.code} ${result.issue.message}`);
                continue;
            }
            console.log(`--- App ${appId} ---`);
            for (const view of result.views) {
                if (!view.content) continue;
                try { console.log(buildViewMessageMarkup({ appId, appName: app.name || appId,
                    viewId: view.id, viewType: view.type, region: view.region,
                    markup: view.content.value })); }
                catch (error) {
                    console.error('[TUI] View presentation unavailable:', error instanceof Error ? error.message : 'Invalid XML field');
                }
            }
        }
    }

    let stopping: Promise<void> | undefined;
    function stop(): Promise<void> {
        if (!stopping) {
            isInteractive = false;
            clearTimeout(previewTimer);
            stopping = runtime.beginClose().completion.then(report => {
                if (!report.ok || !report.resourcesReleased) process.exitCode = 1;
            });
            rl.close();
        }
        return stopping;
    }
    rl.on('close', () => { void stop().catch(error => { process.exitCode = 1;console.error('[TUI] Shutdown failed:', error); }); });

    desktop.output.subscribe(signal => {
        if (!isInteractive || !process.stdout.isTTY || previewTimer || signal.reason === 'attention_requested') return;
        previewTimer = setTimeout(() => {
            previewTimer = undefined;
            void printCurrentViews().then(() => rl.prompt(true)).catch(error => console.error('[TUI] Observation failed:', error));
        }, 150);
    });

    const results = await catalog.installAll(desktop, { name: targetApp, startAll: true }).catch(async error => {
        await stop();
        throw error;
    });
    let running = false;
    for (const result of results) {
        if (result.status === 'installed') {
            running = true;
            console.log(`[TUI] Started ${result.name} (AppID: ${result.appId})`);
        } else if (result.status === 'failed') {
            console.error(`[TUI] ${result.name} failed during ${result.phase}`, result.issue);
        }
    }

    if (!running) {
        console.log('[TUI] No apps started.');
        await stop();
        if (targetApp) process.exitCode = 1;
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
