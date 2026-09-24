import * as os from 'os';
import * as path from 'path';
import {
    CancellationError,
    commands,
    Disposable,
    ProgressLocation,
    QuickPickItem,
    Uri,
    window,
    workspace,
} from 'vscode';

import { traceError } from '../common/logging';
import { runPixi } from './cli';

export interface PixiGlobalDependency {
    name: string;
    version: string;
}

export interface PixiGlobalExposed {
    exposed_name: string;
    executable: string;
}

export interface PixiGlobalEnvironment {
    name: string;
    dependencies?: PixiGlobalDependency[];
    exposed?: PixiGlobalExposed[];
}

interface GlobalActionQuickPickItem extends QuickPickItem {
    action: 'install' | 'list' | 'sync' | 'update' | 'uninstall' | 'edit';
}

let _cachedGlobalManifestPath: string | undefined;

export function clearGlobalManifestCache(): void {
    _cachedGlobalManifestPath = undefined;
}

export async function getGlobalManifestPath(): Promise<string> {
    if (_cachedGlobalManifestPath) {
        return _cachedGlobalManifestPath;
    }
    try {
        const stdout = await runPixi(['info', '--json']);
        const info = JSON.parse(stdout);
        const manifest = info.global_info?.manifest;
        if (typeof manifest === 'string' && manifest.trim()) {
            _cachedGlobalManifestPath = manifest;
            return manifest;
        }
    } catch {
        // Fallback to default path if pixi info fails
    }
    const pixiHome = process.env.PIXI_HOME || path.join(os.homedir(), '.pixi');
    return path.join(pixiHome, 'manifests', 'pixi-global.toml');
}

async function runPixiWithNotification(title: string, args: string[], successMsg: string): Promise<boolean> {
    try {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress, token) => {
                await runPixi(args, undefined, token);
                window.showInformationMessage(successMsg);
            },
        );
        return true;
    } catch (error) {
        if (error instanceof CancellationError) {
            return false;
        }
        window.showErrorMessage(error instanceof Error ? error.message : String(error));
        return false;
    }
}

async function listGlobalEnvironments(): Promise<PixiGlobalEnvironment[] | undefined> {
    try {
        const stdout = await runPixi(['global', 'list', '--json']);
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed)) {
            return parsed as PixiGlobalEnvironment[];
        }
        return [];
    } catch (error) {
        traceError('Failed to list pixi global environments:', error);
        window.showErrorMessage(
            `Failed to list global tools: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
    }
}

async function executeGlobalUpdate(toolName?: string): Promise<boolean> {
    const args = ['global', 'update'];
    if (toolName) {
        args.push(toolName);
    }
    const title = toolName ? `Updating global tool '${toolName}'...` : 'Updating all global tools...';
    const successMsg = toolName ? `Successfully updated '${toolName}'.` : 'Successfully updated all global tools.';

    return runPixiWithNotification(`Pixi Global: ${title}`, args, `Pixi Global: ${successMsg}`);
}

async function executeGlobalUninstall(toolName: string): Promise<boolean> {
    const confirm = await window.showWarningMessage(
        `Are you sure you want to uninstall global tool '${toolName}'?`,
        { modal: true },
        'Uninstall',
    );
    if (confirm !== 'Uninstall') {
        return false;
    }

    return runPixiWithNotification(
        `Pixi Global: Uninstalling ${toolName}...`,
        ['global', 'uninstall', toolName],
        `Pixi Global: Successfully uninstalled ${toolName}.`,
    );
}

async function executeGlobalSync(): Promise<boolean> {
    return runPixiWithNotification(
        'Pixi Global: Syncing global environments...',
        ['global', 'sync'],
        'Pixi Global: Successfully synced global environments.',
    );
}

async function handleGlobalInstall(): Promise<void> {
    const toolInput = await window.showInputBox({
        title: 'Pixi Global: Install Tool',
        prompt: 'Enter tool or package name (supports multiple tools separated by space)',
        placeHolder: 'e.g. ruff ripgrep uv jupyter bat',
        ignoreFocusOut: true,
    });
    if (!toolInput || !toolInput.trim()) {
        return;
    }
    const tools = toolInput.trim().split(/\s+/).filter(Boolean);
    if (tools.length === 0) {
        return;
    }

    const channelPick = await window.showQuickPick(
        [
            {
                label: '$(server) conda-forge (default)',
                description: 'Install from official conda-forge repository',
                channel: undefined,
            },
            {
                label: '$(rocket) Tsinghua Mirror (conda-forge)',
                description: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
                channel: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
            },
            {
                label: '$(rocket) BFSU Mirror (conda-forge)',
                description: 'https://mirrors.bfsu.edu.cn/anaconda/cloud/conda-forge',
                channel: 'https://mirrors.bfsu.edu.cn/anaconda/cloud/conda-forge',
            },
            {
                label: '$(beaker) Bioconda',
                description: 'Bioinformatics and biology package channel',
                channel: 'bioconda',
            },
            {
                label: '$(globe) Custom Channel...',
                description: 'Specify a custom channel name or mirror URL',
                channel: 'custom',
            },
        ],
        {
            title: 'Pixi Global: Select Channel',
            placeHolder: 'Choose package channel for global installation',
        },
    );
    if (!channelPick) {
        return;
    }

    let targetChannel = channelPick.channel;
    if (channelPick.channel === 'custom') {
        const input = await window.showInputBox({
            title: 'Pixi Global: Enter Channel Name or URL',
            prompt: 'Enter Conda channel name or URL',
            placeHolder: 'e.g. bioconda or https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
            ignoreFocusOut: true,
        });
        if (!input || !input.trim()) {
            return;
        }
        targetChannel = input.trim();
    }

    const args = ['global', 'install'];
    if (targetChannel) {
        args.push('-c', targetChannel);
    }
    args.push(...tools);

    await runPixiWithNotification(
        `Pixi Global: Installing ${tools.join(', ')}...`,
        args,
        `Pixi Global: Successfully installed ${tools.join(', ')}.`,
    );
}

async function handleGlobalList(): Promise<void> {
    const tools = await listGlobalEnvironments();
    if (!tools) {
        return;
    }
    if (tools.length === 0) {
        const installNow = 'Install a Tool Now';
        const choice = await window.showInformationMessage('No global tools are currently installed.', installNow);
        if (choice === installNow) {
            await handleGlobalInstall();
        }
        return;
    }

    const items = tools.map((t) => {
        const mainDep = t.dependencies?.[0];
        const versionStr = mainDep?.version ? `v${mainDep.version}` : '';
        const exposedStr = t.exposed?.map((e) => e.exposed_name).join(', ') || t.name;
        return {
            label: `$(tools) ${t.name}`,
            description: versionStr,
            detail: `Exposed commands: ${exposedStr}`,
            tool: t,
        };
    });

    const picked = await window.showQuickPick(items, {
        title: 'Pixi Global: Installed Tools',
        placeHolder: 'Select a tool to manage (Update / Uninstall)',
    });
    if (!picked) {
        return;
    }

    const toolAction = await window.showQuickPick(
        [
            {
                label: '$(refresh) Update Tool',
                description: `Update '${picked.tool.name}' to latest version`,
                action: 'update' as const,
            },
            {
                label: '$(trash) Uninstall Tool',
                description: `Remove '${picked.tool.name}' from global environment`,
                action: 'uninstall' as const,
            },
        ],
        {
            title: `Pixi Global: Manage '${picked.tool.name}'`,
        },
    );

    if (toolAction?.action === 'update') {
        await executeGlobalUpdate(picked.tool.name);
    } else if (toolAction?.action === 'uninstall') {
        await executeGlobalUninstall(picked.tool.name);
    }
}

async function handleGlobalUpdate(): Promise<void> {
    const tools = await listGlobalEnvironments();
    if (!tools) {
        return;
    }
    if (tools.length === 0) {
        window.showInformationMessage('No global tools installed to update.');
        return;
    }

    const choices = [
        {
            label: '$(sync) Update All Tools',
            description: `Update all ${tools.length} global tools to their latest versions`,
            target: undefined,
        },
        ...tools.map((t) => ({
            label: `$(tools) ${t.name}`,
            description: t.dependencies?.[0]?.version ? `v${t.dependencies[0].version}` : '',
            target: t.name,
        })),
    ];

    const picked = await window.showQuickPick(choices, {
        title: 'Pixi Global: Update Tools',
        placeHolder: 'Select all tools or a specific tool to update',
    });
    if (!picked) {
        return;
    }

    await executeGlobalUpdate(picked.target);
}

async function handleGlobalUninstall(): Promise<void> {
    const tools = await listGlobalEnvironments();
    if (!tools) {
        return;
    }
    if (tools.length === 0) {
        window.showInformationMessage('No global tools installed to uninstall.');
        return;
    }

    const items = tools.map((t) => ({
        label: `$(trash) ${t.name}`,
        description: t.dependencies?.[0]?.version ? `v${t.dependencies[0].version}` : '',
        toolName: t.name,
    }));

    const picked = await window.showQuickPick(items, {
        title: 'Pixi Global: Uninstall Tool',
        placeHolder: 'Select a global tool to remove',
    });
    if (!picked) {
        return;
    }

    await executeGlobalUninstall(picked.toolName);
}

async function handleOpenGlobalManifest(): Promise<void> {
    const manifestPath = await getGlobalManifestPath();
    const manifestUri = Uri.file(manifestPath);
    try {
        await workspace.fs.stat(manifestUri);
    } catch {
        const dirUri = Uri.file(path.dirname(manifestPath));
        await workspace.fs.createDirectory(dirUri);
        const initialContent = Buffer.from('# Pixi Global Manifest\n', 'utf-8');
        await workspace.fs.writeFile(manifestUri, initialContent);
    }
    const doc = await workspace.openTextDocument(manifestUri);
    await window.showTextDocument(doc);
}

export function registerGlobalCommands(): Disposable {
    const disposables: Disposable[] = [];

    // Main Submenu Entry Point: Pixi: Global Tools...
    disposables.push(
        commands.registerCommand('pixi.global', async () => {
            const menuItems: GlobalActionQuickPickItem[] = [
                {
                    label: '$(cloud-download) Install Global Tool...',
                    description: 'Install a CLI application into global environment (e.g. ruff, ripgrep, uv)',
                    action: 'install',
                },
                {
                    label: '$(list-unordered) List Global Tools',
                    description: 'Inspect installed global tools, versions, and exposed commands',
                    action: 'list',
                },
                {
                    label: '$(repo-sync) Sync Global Environments',
                    description: 'Sync installed tools with global manifest (pixi global sync)',
                    action: 'sync',
                },
                {
                    label: '$(refresh) Update Global Tools...',
                    description: 'Update all or specific global tools to the latest versions',
                    action: 'update',
                },
                {
                    label: '$(trash) Uninstall Global Tool...',
                    description: 'Remove an installed global tool environment',
                    action: 'uninstall',
                },
                {
                    label: '$(edit) Open Global Manifest',
                    description: 'Open pixi-global.toml in editor',
                    action: 'edit',
                },
            ];

            const selected = await window.showQuickPick(menuItems, {
                title: 'Pixi: Global Tools Management',
                placeHolder: 'Select a global management action',
            });
            if (!selected) {
                return;
            }

            switch (selected.action) {
                case 'install':
                    await handleGlobalInstall();
                    break;
                case 'list':
                    await handleGlobalList();
                    break;
                case 'sync':
                    await executeGlobalSync();
                    break;
                case 'update':
                    await handleGlobalUpdate();
                    break;
                case 'uninstall':
                    await handleGlobalUninstall();
                    break;
                case 'edit':
                    await handleOpenGlobalManifest();
                    break;
            }
        }),
    );

    return Disposable.from(...disposables);
}
