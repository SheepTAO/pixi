import { commands, Disposable, QuickPickItem, window } from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { CONDA_CHANNEL_PRESETS } from '../../core/presets';
import { DEFAULT_CONDA_CHANNEL, getWorkspaceChannels } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import { extractFeatureName, formatScope, pickPixiProject, resolveWorkspaceOrFeatureScope } from './common';

export interface PromptCondaChannelOptions {
    title?: string;
    placeHolder?: string;
    defaultChannelValue?: string | undefined;
    excludeChannels?: ReadonlySet<string>;
}

/**
 * Prompts the user to select a Conda channel preset or enter a custom channel / mirror URL.
 * Returns the selected channel string (or undefined if defaultChannelValue was undefined), or null if cancelled.
 */
export async function promptCondaChannel(options?: PromptCondaChannelOptions): Promise<string | undefined | null> {
    const defaultVal = options?.defaultChannelValue !== undefined ? options.defaultChannelValue : DEFAULT_CONDA_CHANNEL;

    interface ChannelItem extends QuickPickItem {
        channel?: string;
        isCustom?: boolean;
    }

    const availablePresets = CONDA_CHANNEL_PRESETS.filter(
        (p) => !p.channel || !options?.excludeChannels?.has(p.channel),
    );

    const items: ChannelItem[] = [
        ...availablePresets.map((p) => ({
            label: p.label,
            description: p.description,
            channel: p.channel === DEFAULT_CONDA_CHANNEL ? defaultVal : p.channel,
        })),
        {
            label: '$(globe) Custom Channel...',
            description: 'Specify a custom channel name or mirror URL',
            isCustom: true,
        },
    ];

    const pick = await window.showQuickPick(items, {
        title: options?.title || 'Select Conda Channel',
        placeHolder: options?.placeHolder || 'Choose a channel preset or enter a custom channel / mirror URL',
    });
    if (!pick) {
        return null;
    }

    if (pick.isCustom) {
        const input = await window.showInputBox({
            title: options?.title ? `${options.title}: Enter Custom Channel` : 'Enter Conda Channel Name or URL',
            prompt: 'Enter Conda channel name or URL',
            placeHolder: 'e.g. bioconda or https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
            ignoreFocusOut: true,
        });
        if (!input || !input.trim()) {
            return null;
        }
        return input.trim();
    }

    return pick.channel;
}

export function registerChannelCommands(manager: PixiProjectManager): Disposable[] {
    return [
        // Pixi: Add Channel...
        commands.registerCommand('pixi.addChannel', async (targetItem?: unknown, presetFeature?: string) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add channel to', targetItem);
            if (!projectPath) {
                return;
            }

            const targetFeature = await resolveWorkspaceOrFeatureScope(
                projectPath,
                {
                    title: 'Pixi: Select Channel Target Scope',
                    placeHolder: 'Select scope to add channel to',
                    globalLabel: '$(globe) [workspace] (Global Channels)',
                    globalDescription: 'Shared across all environments and features (default)',
                    featureDescription: (name) => `Channels specific to feature '${name}'`,
                },
                targetItem,
                presetFeature,
            );
            if (targetFeature === null) {
                return;
            }

            const existingChannels = getWorkspaceChannels(projectPath);
            const existingInScope = new Set(
                existingChannels.filter((c) => c.feature === targetFeature).map((c) => c.channel),
            );
            const scopeLabel = formatScope(targetFeature);

            const targetChannel = await promptCondaChannel({
                title: `Pixi: Add Channel (${scopeLabel})`,
                placeHolder: 'Select a channel preset or enter a custom channel / mirror URL',
                excludeChannels: existingInScope,
            });
            if (!targetChannel) {
                return;
            }

            const priorityPick = await window.showQuickPick(
                [
                    {
                        label: '$(arrow-down) Append (Default Priority)',
                        description: 'Add to the end of the channel list',
                        prepend: false,
                    },
                    {
                        label: '$(arrow-up) Prepend (--prepend, Highest Priority)',
                        description: 'Add to the start of the channel list (recommended for mirrors)',
                        prepend: true,
                    },
                ],
                {
                    title: `Pixi: Channel Priority (${scopeLabel})`,
                    placeHolder: 'Choose priority position in channels list',
                },
            );
            if (!priorityPick) {
                return;
            }

            const args = ['workspace', 'channel', 'add'];
            if (targetFeature) {
                args.push('-f', targetFeature);
            }
            if (priorityPick.prepend) {
                args.push('--prepend');
            }
            args.push(targetChannel);

            const projectName = manager.getProjectName(projectPath);
            await runPixiWithProgress(
                `Pixi: Adding channel '${targetChannel}' to ${scopeLabel} in '${projectName}'...`,
                args,
                projectPath,
                manager,
                `Pixi: Added channel '${targetChannel}' to ${scopeLabel} in '${projectName}'.`,
            );
        }),

        // Pixi: Remove Channel...
        commands.registerCommand('pixi.removeChannel', async (targetItem?: unknown, presetFeature?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to remove channel from',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const existingChannels = getWorkspaceChannels(projectPath);
            if (existingChannels.length === 0) {
                window.showInformationMessage('No configurable channels found in this Pixi project.');
                return;
            }

            const contextFeature = extractFeatureName(targetItem, presetFeature);
            const filterFeature = contextFeature && contextFeature !== 'default' ? contextFeature : undefined;

            const filteredEntries = filterFeature
                ? existingChannels.filter((c) => c.feature === filterFeature)
                : existingChannels;

            if (filteredEntries.length === 0) {
                window.showInformationMessage(
                    filterFeature
                        ? `No custom channels configured on feature '${filterFeature}'.`
                        : 'No removable channels found in this Pixi project.',
                );
                return;
            }

            const items = filteredEntries.map((c) => ({
                label: `$(globe) ${c.channel}`,
                description: c.feature ? `Feature: ${c.feature}` : 'Workspace (global)',
                channel: c.channel,
                featureScope: c.feature,
            }));

            const selected = await window.showQuickPick(items, {
                title: filterFeature ? `Pixi: Remove Channel (feature '${filterFeature}')` : 'Pixi: Remove Channel',
                placeHolder: 'Select one or more channels to remove from project manifest',
                canPickMany: true,
            });
            if (!selected || selected.length === 0) {
                return;
            }

            const totalGlobalCount = existingChannels.filter((c) => !c.feature).length;
            const removingGlobalCount = selected.filter((s) => !s.featureScope).length;
            if (totalGlobalCount > 0 && removingGlobalCount >= totalGlobalCount) {
                window.showWarningMessage(
                    'Cannot remove all workspace channels. A Pixi project must have at least one channel.',
                );
                return;
            }

            const byScope = new Map<string | undefined, string[]>();
            for (const item of selected) {
                const list = byScope.get(item.featureScope) || [];
                list.push(item.channel);
                byScope.set(item.featureScope, list);
            }

            const commandBatch: string[][] = [];
            for (const [feat, names] of byScope.entries()) {
                const args = ['workspace', 'channel', 'remove'];
                if (feat) {
                    args.push('-f', feat);
                }
                args.push(...names);
                commandBatch.push(args);
            }

            const projectName = manager.getProjectName(projectPath);
            const removedSummary = [...new Set(selected.map((s) => s.channel))].join(', ');
            await runPixiWithProgress(
                `Pixi: Removing channel(s) ${removedSummary} from '${projectName}'...`,
                commandBatch,
                projectPath,
                manager,
                `Pixi: Removed channel(s) ${removedSummary} from '${projectName}'.`,
            );
        }),

        // Pixi: Channel Management (Hub)
        commands.registerCommand('pixi.channel', async (targetItem?: unknown, presetFeature?: string) => {
            const actions = [
                {
                    label: '$(plus) Add Channel...',
                    description:
                        'Add a Conda channel preset, mirror URL, or custom channel to the workspace or a feature',
                    command: 'pixi.addChannel',
                },
                {
                    label: '$(trash) Remove Channel...',
                    description: 'Remove configured channel(s) from the project manifest',
                    command: 'pixi.removeChannel',
                },
                {
                    label: '$(key) Manage Authentication (pixi auth)...',
                    description: 'Login, logout, or manage credentials for private channels and registries',
                    command: 'pixi.auth',
                },
            ];

            const pick = await window.showQuickPick(actions, {
                title: 'Pixi: Channel Management',
                placeHolder: 'Select channel operation',
            });
            if (pick) {
                await commands.executeCommand(pick.command, targetItem, presetFeature);
            }
        }),
    ];
}
