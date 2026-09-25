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

import {
    clearGlobalManifestCache,
    fireGlobalEnvironmentsChanged,
    getGlobalManifestPath,
    installGlobalTools,
    listGlobalEnvironments,
    onDidChangeGlobalEnvironments,
    PixiGlobalEnvironment,
    syncGlobalEnvironments,
    uninstallGlobalTool,
    updateGlobalTool,
} from '../cli/globalCli';

export {
    clearGlobalManifestCache,
    getGlobalManifestPath,
    listGlobalEnvironments,
    onDidChangeGlobalEnvironments,
    PixiGlobalEnvironment,
};

interface GlobalActionQuickPickItem extends QuickPickItem {
    action: 'install' | 'list' | 'sync' | 'update' | 'uninstall' | 'edit';
}

async function runWithProgressNotification(
    title: string,
    action: () => Promise<unknown>,
    successMsg: string,
): Promise<boolean> {
    try {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress) => {
                await action();
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

export async function executeGlobalUpdate(toolName?: string): Promise<boolean> {
    const title = toolName
        ? `Pixi Global: Updating tool '${toolName}'...`
        : 'Pixi Global: Updating all global tools...';
    const successMsg = toolName
        ? `Pixi Global: Successfully updated '${toolName}'.`
        : 'Pixi Global: Successfully updated all global tools.';

    return runWithProgressNotification(title, () => updateGlobalTool(toolName), successMsg);
}

export async function executeGlobalUninstall(toolName: string): Promise<boolean> {
    const confirm = await window.showWarningMessage(
        `Are you sure you want to uninstall global tool '${toolName}'?`,
        { modal: true },
        'Uninstall',
    );
    if (confirm !== 'Uninstall') {
        return false;
    }

    return runWithProgressNotification(
        `Pixi Global: Uninstalling tool '${toolName}'...`,
        () => uninstallGlobalTool(toolName),
        `Pixi Global: Successfully uninstalled tool '${toolName}'.`,
    );
}

export async function executeGlobalSync(): Promise<boolean> {
    return runWithProgressNotification(
        'Pixi Global: Syncing global environments...',
        () => syncGlobalEnvironments(),
        'Pixi Global: Successfully synced global environments.',
    );
}

export async function handleGlobalInstall(initialTool?: string): Promise<void> {
    let tools: string[] = [];
    if (initialTool && typeof initialTool === 'string' && initialTool.trim()) {
        tools = [initialTool.trim()];
    } else {
        const toolInput = await window.showInputBox({
            title: 'Pixi Global: Install Tool',
            prompt: 'Enter tool or package name (supports multiple tools separated by space)',
            placeHolder: 'e.g. ruff ripgrep uv jupyter bat',
            ignoreFocusOut: true,
        });
        if (!toolInput || !toolInput.trim()) {
            return;
        }
        tools = toolInput.trim().split(/\s+/).filter(Boolean);
        if (tools.length === 0) {
            return;
        }
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

    const channelLabel = targetChannel ? `channel: ${targetChannel}` : 'channel: conda-forge';
    await runWithProgressNotification(
        `Pixi Global: Installing '${tools.join(', ')}' (${channelLabel})...`,
        () => installGlobalTools(tools, targetChannel),
        `Pixi Global: Successfully installed '${tools.join(', ')}' (${channelLabel}).`,
    );
}

export async function handleGlobalList(): Promise<void> {
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

export async function handleGlobalUpdate(): Promise<void> {
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

export async function handleGlobalUninstall(): Promise<void> {
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

export async function handleOpenGlobalManifest(): Promise<void> {
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

    disposables.push(
        commands.registerCommand('pixi.refreshGlobal', () => {
            fireGlobalEnvironmentsChanged();
        }),
        commands.registerCommand('pixi.global.install', async (target?: any) => {
            const initialTool = typeof target === 'string' ? target : undefined;
            await handleGlobalInstall(initialTool);
        }),
        commands.registerCommand('pixi.global.sync', async () => {
            await executeGlobalSync();
        }),
        commands.registerCommand('pixi.global.updateTool', async (item?: any) => {
            const toolName = typeof item === 'string' ? item : item?.tool?.name;
            await executeGlobalUpdate(toolName);
        }),
        commands.registerCommand('pixi.global.uninstallTool', async (item?: any) => {
            const toolName = typeof item === 'string' ? item : item?.tool?.name;
            if (toolName) {
                await executeGlobalUninstall(toolName);
            } else {
                await handleGlobalUninstall();
            }
        }),
        commands.registerCommand('pixi.global.openManifest', async () => {
            await handleOpenGlobalManifest();
        }),
    );

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
