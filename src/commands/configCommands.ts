import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commands, Disposable, OutputChannel, QuickPickItem, Uri, window, workspace } from 'vscode';

import { runPixi } from '../cli/pixiCli';
import { runPixiWithProgress } from '../cli/workspaceCli';
import { runWithProgressNotification } from '../common/execUtils';
import { PixiProjectManager } from '../core/projectManager';
import { pickPixiProject } from './workspace/common';

let configOutputChannel: OutputChannel | undefined;

function getConfigOutputChannel(): OutputChannel {
    if (!configOutputChannel) {
        configOutputChannel = window.createOutputChannel('Pixi Configuration');
    }
    return configOutputChannel;
}

export type ConfigScope = 'local' | 'global' | 'system' | 'merged';

interface ScopeQuickPickItem extends QuickPickItem {
    scope: ConfigScope;
}

const SCOPE_ITEMS: ScopeQuickPickItem[] = [
    {
        label: '$(globe) Global Configuration',
        description: '~/.pixi/config.toml',
        detail: 'User-level configuration applied across all workspaces',
        scope: 'global',
    },
    {
        label: '$(root-folder) Workspace Local Configuration',
        description: '.pixi/config.toml',
        detail: 'Workspace-specific configuration stored in project root',
        scope: 'local',
    },
    {
        label: '$(server) System Configuration',
        description: 'System-wide configuration',
        detail: 'Applies to all users on this machine',
        scope: 'system',
    },
];

const PRESET_CONFIG_KEYS = [
    {
        key: 'default-channels',
        description: 'Default channels when creating new workspaces or resolving packages',
        placeholder: 'e.g. ["conda-forge", "bioconda"]',
    },
    {
        key: 'pinning-strategy',
        description: 'Default pinning strategy (semver, minor, major, latest-up, exact-version, no-pin)',
        placeholder: 'semver',
    },
    {
        key: 'concurrent-downloads',
        description: 'Maximum concurrent network requests (default: 50)',
        placeholder: '50',
    },
    {
        key: 'concurrent-solves',
        description: 'Maximum concurrent solves (default: number of CPUs)',
        placeholder: '4',
    },
    {
        key: 'tls-no-verify',
        description: 'Whether to skip TLS certificate verification (true / false)',
        placeholder: 'false',
    },
    {
        key: 'pypi-keyring-provider',
        description: 'Keyring provider for PyPI authentication (disabled, subprocess)',
        placeholder: 'disabled',
    },
];

async function pickScope(
    includeMerged = false,
    title = 'Pixi Configuration: Select Scope',
): Promise<ConfigScope | undefined> {
    const items: ScopeQuickPickItem[] = [...SCOPE_ITEMS];
    if (includeMerged) {
        items.unshift({
            label: '$(layers) Merged / Effective Configuration',
            description: 'All active settings',
            detail: 'Displays the resolved configuration combined from all levels',
            scope: 'merged',
        });
    }

    const picked = await window.showQuickPick(items, {
        title,
        placeHolder: 'Select configuration level',
    });
    return picked?.scope;
}

export async function handleConfigList(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const scope = await pickScope(true, 'Pixi: List Configuration Values');
    if (!scope) {
        return;
    }

    let projectPath: string | undefined;
    if (scope === 'local' || scope === 'merged') {
        projectPath = await pickPixiProject(manager, 'Select Pixi project for local configuration', targetItem);
        if (scope === 'local' && !projectPath) {
            return;
        }
    }

    const keyChoice = await window.showQuickPick(
        [
            { label: '$(list-unordered) Show All Configuration Keys', key: '' },
            ...PRESET_CONFIG_KEYS.map((k) => ({
                label: `$(gear) ${k.key}`,
                description: k.description,
                key: k.key,
            })),
            { label: '$(edit) Specific key...', key: '__CUSTOM__' },
        ],
        {
            title: 'Pixi: Select Configuration Key to Inspect',
            placeHolder: 'Select all keys or choose a specific key',
        },
    );
    if (!keyChoice) {
        return;
    }

    let targetKey = keyChoice.key;
    if (targetKey === '__CUSTOM__') {
        const inputKey = await window.showInputBox({
            title: 'Pixi: Inspect Configuration Key',
            prompt: 'Enter configuration key name',
            placeHolder: 'e.g. default-channels or mirrors',
        });
        if (!inputKey || !inputKey.trim()) {
            return;
        }
        targetKey = inputKey.trim();
    }

    const args = ['config', 'list'];
    if (scope === 'local') {
        args.push('--local');
    } else if (scope === 'global') {
        args.push('--global');
    } else if (scope === 'system') {
        args.push('--system');
    }

    if (targetKey) {
        args.push(targetKey);
    }

    const channel = getConfigOutputChannel();
    try {
        const stdout = await runPixi(args, projectPath ? { cwd: projectPath } : undefined);
        channel.clear();
        channel.appendLine(`=== Pixi Configuration (${scope.toUpperCase()}${targetKey ? `: ${targetKey}` : ''}) ===\n`);
        channel.appendLine(stdout.trim() || 'Configuration not set.');
        channel.show(true);
    } catch (err: unknown) {
        window.showErrorMessage(
            `Failed to list Pixi configuration: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

export async function handleConfigEdit(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const scope = await pickScope(false, 'Pixi: Edit Configuration File');
    if (!scope) {
        return;
    }

    let configFilePath: string | undefined;
    if (scope === 'global') {
        configFilePath = path.join(os.homedir(), '.pixi', 'config.toml');
    } else if (scope === 'local') {
        const projectPath = await pickPixiProject(manager, 'Select Pixi project for local configuration', targetItem);
        if (!projectPath) {
            return;
        }
        configFilePath = path.join(projectPath, '.pixi', 'config.toml');
    } else if (scope === 'system') {
        configFilePath =
            process.platform === 'win32'
                ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'pixi', 'config.toml')
                : '/etc/pixi/config.toml';
    }

    if (!configFilePath) {
        return;
    }

    try {
        if (!fs.existsSync(configFilePath)) {
            const dir = path.dirname(configFilePath);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            const header = `# Pixi Configuration (${scope})\n# See https://pixi.sh/latest/reference/pixi_configuration/\n\n`;
            await fs.promises.writeFile(configFilePath, header, 'utf8');
        }
        const doc = await workspace.openTextDocument(Uri.file(configFilePath));
        await window.showTextDocument(doc);
    } catch (err: unknown) {
        window.showErrorMessage(
            `Failed to open configuration file '${configFilePath}': ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

async function executeConfigMutation(
    title: string,
    args: string[],
    scope: ConfigScope,
    projectPath: string | undefined,
    manager: PixiProjectManager,
    successMsg: string,
): Promise<void> {
    if (scope === 'local' && projectPath) {
        await runPixiWithProgress(title, args, projectPath, manager, successMsg);
    } else {
        await runWithProgressNotification(
            title,
            async (token) => {
                const out = await runPixi(args, { includeStderr: true }, token);
                await manager.refreshAll();
                return out;
            },
            successMsg,
        );
    }
}

export async function handleConfigSet(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const scope = await pickScope(false, 'Pixi: Set Configuration Value');
    if (!scope) {
        return;
    }

    let projectPath: string | undefined;
    if (scope === 'local') {
        projectPath = await pickPixiProject(manager, 'Select Pixi project for local configuration', targetItem);
        if (!projectPath) {
            return;
        }
    }

    const keyPick = await window.showQuickPick(
        [
            ...PRESET_CONFIG_KEYS.map((k) => ({
                label: `$(gear) ${k.key}`,
                description: k.description,
                placeholder: k.placeholder,
                key: k.key,
            })),
            {
                label: '$(edit) Custom Configuration Key...',
                description: 'Enter a custom configuration key name',
                placeholder: '',
                key: '__CUSTOM__',
            },
        ],
        {
            title: 'Pixi: Choose Configuration Key to Set',
            placeHolder: 'Select a setting to configure',
        },
    );
    if (!keyPick) {
        return;
    }

    let targetKey = keyPick.key;
    let placeholder = keyPick.placeholder;
    if (targetKey === '__CUSTOM__') {
        const inputKey = await window.showInputBox({
            title: 'Pixi: Set Configuration Key',
            prompt: 'Enter configuration key name',
            placeHolder: 'e.g. mirrors."https://conda.anaconda.org/conda-forge"',
        });
        if (!inputKey || !inputKey.trim()) {
            return;
        }
        targetKey = inputKey.trim();
        placeholder = 'value';
    }

    const valueInput = await window.showInputBox({
        title: `Pixi: Set '${targetKey}' (${scope})`,
        prompt: `Enter value for '${targetKey}' (TOML or JSON format for arrays/objects, or plain string/number/boolean)`,
        placeHolder: placeholder,
    });
    if (valueInput === undefined) {
        return;
    }

    const args = ['config', 'set'];
    if (scope === 'local') {
        args.push('--local');
    } else if (scope === 'global') {
        args.push('--global');
    } else if (scope === 'system') {
        args.push('--system');
    }
    args.push(targetKey, valueInput.trim());

    await executeConfigMutation(
        `Pixi: Setting '${targetKey}' in ${scope} configuration...`,
        args,
        scope,
        projectPath,
        manager,
        `Pixi: Configuration '${targetKey}' updated successfully.`,
    );
}

export async function handleConfigUnset(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const scope = await pickScope(false, 'Pixi: Unset Configuration Value');
    if (!scope) {
        return;
    }

    let projectPath: string | undefined;
    if (scope === 'local') {
        projectPath = await pickPixiProject(manager, 'Select Pixi project for local configuration', targetItem);
        if (!projectPath) {
            return;
        }
    }

    const keyPick = await window.showQuickPick(
        [
            ...PRESET_CONFIG_KEYS.map((k) => ({
                label: `$(trash) ${k.key}`,
                description: k.description,
                key: k.key,
            })),
            {
                label: '$(edit) Custom Configuration Key...',
                description: 'Enter configuration key name to unset',
                key: '__CUSTOM__',
            },
        ],
        {
            title: 'Pixi: Choose Configuration Key to Unset',
            placeHolder: 'Select a setting to remove',
        },
    );
    if (!keyPick) {
        return;
    }

    let targetKey = keyPick.key;
    if (targetKey === '__CUSTOM__') {
        const inputKey = await window.showInputBox({
            title: 'Pixi: Unset Configuration Key',
            prompt: 'Enter configuration key name to remove',
            placeHolder: 'e.g. default-channels',
        });
        if (!inputKey || !inputKey.trim()) {
            return;
        }
        targetKey = inputKey.trim();
    }

    const args = ['config', 'unset'];
    if (scope === 'local') {
        args.push('--local');
    } else if (scope === 'global') {
        args.push('--global');
    } else if (scope === 'system') {
        args.push('--system');
    }
    args.push(targetKey);

    await executeConfigMutation(
        `Pixi: Unsetting '${targetKey}' in ${scope} configuration...`,
        args,
        scope,
        projectPath,
        manager,
        `Pixi: Configuration '${targetKey}' unset successfully.`,
    );
}

export async function handleConfigListMutation(
    action: 'append' | 'prepend',
    manager: PixiProjectManager,
    targetItem?: unknown,
): Promise<void> {
    const scope = await pickScope(false, `Pixi: ${action === 'append' ? 'Append' : 'Prepend'} to Configuration List`);
    if (!scope) {
        return;
    }

    let projectPath: string | undefined;
    if (scope === 'local') {
        projectPath = await pickPixiProject(manager, 'Select Pixi project for local configuration', targetItem);
        if (!projectPath) {
            return;
        }
    }

    const key = await window.showInputBox({
        title: `Pixi: ${action === 'append' ? 'Append' : 'Prepend'} List Key`,
        prompt: 'Enter list configuration key',
        value: 'default-channels',
    });
    if (!key || !key.trim()) {
        return;
    }

    const val = await window.showInputBox({
        title: `Pixi: ${action === 'append' ? 'Append' : 'Prepend'} to '${key.trim()}'`,
        prompt: 'Enter value to add to list',
        placeHolder: 'e.g. bioconda or conda-forge',
    });
    if (!val || !val.trim()) {
        return;
    }

    const args = ['config', action];
    if (scope === 'local') {
        args.push('--local');
    } else if (scope === 'global') {
        args.push('--global');
    } else if (scope === 'system') {
        args.push('--system');
    }
    args.push(key.trim(), val.trim());

    await executeConfigMutation(
        `Pixi: ${action === 'append' ? 'Appending to' : 'Prepending to'} '${key.trim()}'...`,
        args,
        scope,
        projectPath,
        manager,
        `Pixi: Successfully updated '${key.trim()}'.`,
    );
}

export function registerConfigCommands(manager: PixiProjectManager): Disposable {
    return Disposable.from(
        commands.registerCommand('pixi.config.list', (target?: unknown) => handleConfigList(manager, target)),
        commands.registerCommand('pixi.config.edit', (target?: unknown) => handleConfigEdit(manager, target)),
        commands.registerCommand('pixi.config.set', (target?: unknown) => handleConfigSet(manager, target)),
        commands.registerCommand('pixi.config.unset', (target?: unknown) => handleConfigUnset(manager, target)),
        commands.registerCommand('pixi.config', async (target?: unknown) => {
            interface ConfigActionItem extends QuickPickItem {
                action: 'list' | 'edit' | 'set' | 'unset' | 'append' | 'prepend';
            }

            const items: ConfigActionItem[] = [
                {
                    label: '$(list-unordered) List Configuration Values',
                    description: 'pixi config list',
                    detail: 'Inspect active configuration settings across local, global, and system scopes',
                    action: 'list',
                },
                {
                    label: '$(edit) Edit Configuration File...',
                    description: 'pixi config edit',
                    detail: 'Open config.toml (global, workspace, or system) directly in editor',
                    action: 'edit',
                },
                {
                    label: '$(gear) Set Configuration Value...',
                    description: 'pixi config set KEY VALUE',
                    detail: 'Set or update a configuration key (e.g. default-channels, pinning-strategy)',
                    action: 'set',
                },
                {
                    label: '$(trash) Unset Configuration Value...',
                    description: 'pixi config unset KEY',
                    detail: 'Remove a custom configuration key and revert to defaults',
                    action: 'unset',
                },
                {
                    label: '$(add) Append Value to List Configuration...',
                    description: 'pixi config append KEY VALUE',
                    detail: 'Append an entry to a list setting (e.g. adding a channel)',
                    action: 'append',
                },
                {
                    label: '$(chevron-up) Prepend Value to List Configuration...',
                    description: 'pixi config prepend KEY VALUE',
                    detail: 'Prepend an entry to a list setting with highest priority',
                    action: 'prepend',
                },
            ];

            const picked = await window.showQuickPick(items, {
                title: 'Pixi: Configuration Management',
                placeHolder: 'Select a configuration management action',
            });
            if (!picked) {
                return;
            }

            switch (picked.action) {
                case 'list':
                    await handleConfigList(manager, target);
                    break;
                case 'edit':
                    await handleConfigEdit(manager, target);
                    break;
                case 'set':
                    await handleConfigSet(manager, target);
                    break;
                case 'unset':
                    await handleConfigUnset(manager, target);
                    break;
                case 'append':
                    await handleConfigListMutation('append', manager, target);
                    break;
                case 'prepend':
                    await handleConfigListMutation('prepend', manager, target);
                    break;
            }
        }),
    );
}
