import * as path from 'path';
import { commands, Disposable, QuickPickItem, window } from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { getWorkspaceChannels } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import {
    executeScopedWorkspaceRemove,
    extractFeatureName,
    pickPixiProject,
    resolveWorkspaceOrFeatureScope,
    ScopedRemovalQuickPickItem,
} from './common';

export interface CondaChannelPreset {
    label: string;
    description: string;
    channel?: string;
}

export const CONDA_CHANNEL_PRESETS: readonly CondaChannelPreset[] = [
    {
        label: '$(server) conda-forge (default)',
        description: 'Community-driven Conda repository (default)',
        channel: 'conda-forge',
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
        label: '$(rocket) Aliyun Mirror (conda-forge)',
        description: 'https://mirrors.aliyun.com/anaconda/cloud/conda-forge',
        channel: 'https://mirrors.aliyun.com/anaconda/cloud/conda-forge',
    },
    {
        label: '$(server) pytorch',
        description: 'Official PyTorch Conda channel',
        channel: 'pytorch',
    },
    {
        label: '$(server) nvidia',
        description: 'Official NVIDIA CUDA packages channel',
        channel: 'nvidia',
    },
    {
        label: '$(beaker) bioconda',
        description: 'Bioinformatics and biology package channel',
        channel: 'bioconda',
    },
];

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
    const defaultVal = options?.defaultChannelValue !== undefined ? options.defaultChannelValue : 'conda-forge';

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
            channel: p.channel === 'conda-forge' ? defaultVal : p.channel,
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
            const scopeLabel = targetFeature ? `feature '${targetFeature}'` : 'workspace';

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

            const projectName = path.basename(projectPath);
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

            const items: ScopedRemovalQuickPickItem[] = filteredEntries.map((c) => ({
                label: `$(globe) ${c.channel}`,
                description: c.feature ? `Feature: ${c.feature}` : 'Workspace (global)',
                itemName: c.channel,
                featureScope: c.feature,
            }));

            await executeScopedWorkspaceRemove({
                subcommand: 'channel',
                noun: 'channel',
                nounPlural: 'channels',
                projectPath,
                manager,
                items,
                totalGlobalCount: existingChannels.filter((c) => !c.feature).length,
                filterFeature,
                emptyGlobalWarning:
                    'Cannot remove all workspace channels. A Pixi project must have at least one channel.',
            });
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
