import * as path from 'path';
import { commands, Disposable, QuickPickItem, Uri, window, workspace } from 'vscode';

import {
    addGlobalDependency,
    exposeGlobalBinary,
    extractToolName,
    getGlobalManifestPath,
    getToolVersion,
    installGlobalTools,
    listGlobalEnvironments,
    PixiGlobalEnvironment,
    refreshGlobalEnvironments,
    removeGlobalDependency,
    syncGlobalEnvironments,
    unexposeGlobalBinary,
    uninstallGlobalTool,
    updateGlobalTool,
} from '../cli/globalCli';
import { runWithProgressNotification } from '../common/execUtils';
import { DEFAULT_CONDA_CHANNEL } from '../core/projectDiscovery';
import { promptCondaChannel } from './workspace/channelCommands';
import { displayTreeOutput } from './workspace/packageTreeViewer';

interface GlobalActionQuickPickItem extends QuickPickItem {
    action:
        | 'install'
        | 'list'
        | 'sync'
        | 'update'
        | 'uninstall'
        | 'edit'
        | 'tree'
        | 'add-dep'
        | 'remove-dep'
        | 'expose'
        | 'self-update';
}

export async function executeGlobalTree(toolName: string): Promise<void> {
    const globalManifestPath = await getGlobalManifestPath();
    const manifestDir = path.dirname(globalManifestPath);
    await displayTreeOutput(
        `Global tool '${toolName}'`,
        ['global', 'tree', '--color', 'never', '-e', toolName],
        manifestDir,
    );
}

export async function executeGlobalUpdate(toolName?: string): Promise<boolean> {
    const title = toolName
        ? `Pixi Global: Updating tool '${toolName}'...`
        : 'Pixi Global: Updating all global tools...';
    const successMsg = toolName
        ? `Pixi Global: Successfully updated '${toolName}'.`
        : 'Pixi Global: Successfully updated all global tools.';

    return runWithProgressNotification(title, (token) => updateGlobalTool(toolName, token), successMsg);
}

export async function executeGlobalUninstall(toolName: string): Promise<boolean> {
    const confirm = await window.showWarningMessage(
        `Are you sure you want to uninstall global tool '${toolName}'?`,
        'Uninstall',
    );
    if (confirm !== 'Uninstall') {
        return false;
    }

    return runWithProgressNotification(
        `Pixi Global: Uninstalling tool '${toolName}'...`,
        (token) => uninstallGlobalTool(toolName, token),
        `Pixi Global: Successfully uninstalled tool '${toolName}'.`,
    );
}

export async function executeGlobalSync(): Promise<boolean> {
    return runWithProgressNotification(
        'Pixi Global: Syncing global environments...',
        (token) => syncGlobalEnvironments(token),
        'Pixi Global: Successfully synced global environments.',
    );
}

export async function handleGlobalInstall(initialTool?: string): Promise<void> {
    let tools: string[] = [];
    if (initialTool?.trim()) {
        tools = [initialTool.trim()];
    } else {
        const toolInput = await window.showInputBox({
            title: 'Pixi Global: Install Tool',
            prompt: 'Enter tool or package name (supports multiple tools separated by space)',
            placeHolder: 'e.g. ruff ripgrep uv jupyter bat',
            ignoreFocusOut: true,
        });
        const trimmed = toolInput?.trim();
        if (!trimmed) {
            return;
        }
        tools = trimmed.split(/\s+/);
    }

    const targetChannel = await promptCondaChannel({
        title: 'Pixi Global: Select Channel',
        placeHolder: 'Choose package channel for global installation',
        defaultChannelValue: undefined,
    });
    if (targetChannel === null) {
        return;
    }

    const channelLabel = targetChannel ? `channel: ${targetChannel}` : `channel: ${DEFAULT_CONDA_CHANNEL}`;
    await runWithProgressNotification(
        `Pixi Global: Installing '${tools.join(', ')}' (${channelLabel})...`,
        (token) => installGlobalTools(tools, targetChannel, token),
        `Pixi Global: Successfully installed '${tools.join(', ')}' (${channelLabel}).`,
    );
}

export function toGlobalToolItem(t: PixiGlobalEnvironment): QuickPickItem & { tool: PixiGlobalEnvironment } {
    const exposedStr = t.exposed?.map((e) => e.exposed_name).join(', ') || t.name;
    return {
        label: `$(tools) ${t.name}`,
        description: getToolVersion(t),
        detail: `Exposed commands: ${exposedStr}`,
        tool: t,
    };
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

    const items = tools.map(toGlobalToolItem);

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
                label: '$(graph) View Dependency Tree',
                description: `Show dependency tree for '${picked.tool.name}' (pixi global tree)`,
                action: 'tree' as const,
            },
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

    if (toolAction?.action === 'tree') {
        await executeGlobalTree(picked.tool.name);
    } else if (toolAction?.action === 'update') {
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
            description: getToolVersion(t),
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
        description: getToolVersion(t),
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

export async function handleGlobalAddDependency(initialTool?: string): Promise<void> {
    let toolName = initialTool;
    if (!toolName) {
        const tools = await listGlobalEnvironments();
        if (!tools || tools.length === 0) {
            window.showInformationMessage('No global tools installed to add dependencies to.');
            return;
        }
        const picked = await window.showQuickPick(
            tools.map((t) => ({
                label: `$(tools) ${t.name}`,
                description: getToolVersion(t),
                toolName: t.name,
            })),
            {
                title: 'Pixi Global: Add Dependency to Tool Environment',
                placeHolder: 'Select a global tool environment to add dependencies to',
            },
        );
        if (!picked) {
            return;
        }
        toolName = picked.toolName;
    }

    const input = await window.showInputBox({
        title: `Pixi Global: Add Dependency to '${toolName}'`,
        prompt: 'Enter package name(s) to add to this global environment (separated by space)',
        placeHolder: 'e.g. pytest-cov pytest-xdist',
    });
    const trimmed = input?.trim();
    if (!trimmed) {
        return;
    }

    const packages = trimmed.split(/\s+/);
    await runWithProgressNotification(
        `Pixi Global: Adding '${packages.join(', ')}' to '${toolName}'...`,
        (token) => addGlobalDependency(toolName!, packages, token),
        `Pixi Global: Successfully added dependencies to '${toolName}'.`,
    );
}

export async function handleGlobalRemoveDependency(initialTool?: string): Promise<void> {
    const tools = await listGlobalEnvironments();
    if (!tools || tools.length === 0) {
        window.showInformationMessage('No global tools installed.');
        return;
    }

    let targetTool = tools.find((t) => t.name === initialTool);
    if (!targetTool) {
        const pickedTool = await window.showQuickPick(
            tools.map((t) => ({
                label: `$(tools) ${t.name}`,
                description: getToolVersion(t),
                tool: t,
            })),
            {
                title: 'Pixi Global: Remove Dependency from Tool Environment',
                placeHolder: 'Select global tool environment',
            },
        );
        if (!pickedTool) {
            return;
        }
        targetTool = pickedTool.tool;
    }

    const deps = targetTool.dependencies || [];
    if (deps.length <= 1) {
        window.showInformationMessage(
            `'${targetTool.name}' has no extra dependencies to remove (use Uninstall Tool to remove the tool entirely).`,
        );
        return;
    }

    const pickedDep = await window.showQuickPick(
        deps.map((d) => ({
            label: `$(trash) ${d.name}`,
            description: `v${d.version}`,
            depName: d.name,
        })),
        {
            title: `Pixi Global: Remove Dependency from '${targetTool.name}'`,
            placeHolder: 'Select dependency to remove',
        },
    );
    if (!pickedDep) {
        return;
    }

    await runWithProgressNotification(
        `Pixi Global: Removing '${pickedDep.depName}' from '${targetTool.name}'...`,
        (token) => removeGlobalDependency(targetTool!.name, [pickedDep.depName], token),
        `Pixi Global: Successfully removed '${pickedDep.depName}' from '${targetTool.name}'.`,
    );
}

export async function handleGlobalExpose(initialTool?: string): Promise<void> {
    const tools = await listGlobalEnvironments();
    if (!tools || tools.length === 0) {
        window.showInformationMessage('No global tools installed.');
        return;
    }

    let targetTool = tools.find((t) => t.name === initialTool);
    if (!targetTool) {
        const picked = await window.showQuickPick(
            tools.map((t) => ({
                label: `$(tools) ${t.name}`,
                description: getToolVersion(t),
                tool: t,
            })),
            {
                title: 'Pixi Global: Manage Exposed Binaries',
                placeHolder: 'Select global tool environment to manage exposed binaries for',
            },
        );
        if (!picked) {
            return;
        }
        targetTool = picked.tool;
    }

    const toolName = targetTool.name;
    const exposedList = targetTool.exposed || [];

    if (exposedList.length > 0) {
        const action = await window.showQuickPick(
            [
                {
                    label: '$(plus) Add Exposed Binary...',
                    description: `Expose an executable or alias from '${toolName}' (pixi global expose add)`,
                    action: 'add',
                },
                {
                    label: '$(trash) Remove Exposed Binary...',
                    description: `Remove an exposed executable alias for '${toolName}' (pixi global expose remove)`,
                    action: 'remove',
                },
            ],
            {
                title: `Pixi Global: Manage Exposed Binaries for '${toolName}'`,
                placeHolder: 'Choose whether to expose a new executable or remove an existing one',
            },
        );
        if (!action) {
            return;
        }

        if (action.action === 'remove') {
            const pickedExp = await window.showQuickPick(
                exposedList.map((e) => ({
                    label: `$(trash) ${e.exposed_name}`,
                    description: e.executable ? `-> ${e.executable}` : '',
                    exposedName: e.exposed_name,
                })),
                {
                    title: `Pixi Global: Remove Exposed Binary from '${toolName}'`,
                    placeHolder: 'Select exposed binary to remove',
                },
            );
            if (!pickedExp) {
                return;
            }

            await runWithProgressNotification(
                `Pixi Global: Removing exposed binary '${pickedExp.exposedName}'...`,
                (token) => unexposeGlobalBinary([pickedExp.exposedName], token),
                `Pixi Global: Successfully removed exposed binary '${pickedExp.exposedName}'.`,
            );
            return;
        }
    }

    const mapping = await window.showInputBox({
        title: `Pixi Global: Expose Binary Mapping for '${toolName}'`,
        prompt: 'Enter binary mapping in exposed_name=executable_name format or executable_name',
        placeHolder: 'e.g. pytest or python310=python3.10',
    });
    if (!mapping || !mapping.trim()) {
        return;
    }

    await runWithProgressNotification(
        `Pixi Global: Exposing binary '${mapping.trim()}' for '${toolName}'...`,
        (token) => exposeGlobalBinary(toolName, mapping.trim(), token),
        `Pixi Global: Successfully exposed binary '${mapping.trim()}'.`,
    );
}

export function registerGlobalCommands(): Disposable {
    return Disposable.from(
        commands.registerCommand('pixi.refreshGlobal', () => {
            refreshGlobalEnvironments();
        }),
        commands.registerCommand('pixi.global.install', async (target?: unknown) => {
            const initialTool = typeof target === 'string' ? target : undefined;
            await handleGlobalInstall(initialTool);
        }),
        commands.registerCommand('pixi.global.sync', async () => {
            await executeGlobalSync();
        }),
        commands.registerCommand('pixi.global.updateTool', async (item?: unknown) => {
            await executeGlobalUpdate(extractToolName(item));
        }),
        commands.registerCommand('pixi.global.uninstallTool', async (item?: unknown) => {
            const toolName = extractToolName(item);
            if (toolName) {
                await executeGlobalUninstall(toolName);
            } else {
                await handleGlobalUninstall();
            }
        }),
        commands.registerCommand('pixi.global.addDependency', async (item?: unknown) => {
            await handleGlobalAddDependency(extractToolName(item));
        }),
        commands.registerCommand('pixi.global.removeDependency', async (item?: unknown) => {
            await handleGlobalRemoveDependency(extractToolName(item));
        }),
        commands.registerCommand('pixi.global.expose', async (item?: unknown) => {
            await handleGlobalExpose(extractToolName(item));
        }),
        commands.registerCommand('pixi.global.tree', async (item?: unknown) => {
            let toolName = extractToolName(item);
            if (!toolName) {
                const tools = await listGlobalEnvironments();
                if (!tools || tools.length === 0) {
                    window.showInformationMessage('No global tools installed to view dependency tree for.');
                    return;
                }
                const picked = await window.showQuickPick(tools.map(toGlobalToolItem), {
                    title: 'Pixi Global: View Dependency Tree',
                    placeHolder: 'Select a tool to view its dependency tree',
                });
                if (!picked) {
                    return;
                }
                toolName = picked.tool.name;
            }
            await executeGlobalTree(toolName);
        }),
        commands.registerCommand('pixi.global.openManifest', async () => {
            await handleOpenGlobalManifest();
        }),
        // Main Submenu Entry Point: Pixi: Global Tools...
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
                    label: '$(add) Add Dependency to Global Tool...',
                    description: 'Add extra packages to an existing global tool environment (pixi global add)',
                    action: 'add-dep',
                },
                {
                    label: '$(trash) Remove Dependency from Global Tool...',
                    description: 'Remove an extra package from a global tool environment (pixi global remove)',
                    action: 'remove-dep',
                },
                {
                    label: '$(symbol-event) Expose Binary Mapping...',
                    description: 'Expose or alias an executable from a global environment (pixi global expose)',
                    action: 'expose',
                },
                {
                    label: '$(graph) View Dependency Tree...',
                    description: 'Display dependency tree for a globally installed tool (pixi global tree)',
                    action: 'tree',
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
                {
                    label: '$(arrow-up) Update Pixi CLI (Self-Update)...',
                    description: 'Check for updates or update the Pixi CLI binary (pixi self-update)',
                    action: 'self-update',
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
                case 'add-dep':
                    await handleGlobalAddDependency();
                    break;
                case 'remove-dep':
                    await handleGlobalRemoveDependency();
                    break;
                case 'expose':
                    await handleGlobalExpose();
                    break;
                case 'tree':
                    await commands.executeCommand('pixi.global.tree');
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
                case 'self-update':
                    await commands.executeCommand('pixi.selfUpdate');
                    break;
            }
        }),
    );
}
