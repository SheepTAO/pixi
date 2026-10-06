import * as path from 'path';
import { commands, Disposable, QuickPickItem, Uri, window } from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { PixiProjectManager } from '../../core/projectManager';
import { pickPixiProject } from './common';

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

    const items: ChannelItem[] = [
        ...CONDA_CHANNEL_PRESETS.map((p) => ({
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
        commands.registerCommand('pixi.addChannel', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add channel to', folderUri);
            if (!projectPath) {
                return;
            }

            const targetChannel = await promptCondaChannel({
                title: 'Pixi: Add Channel',
                placeHolder: 'Select a channel preset or enter a custom channel / mirror URL',
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
                    title: 'Pixi: Channel Priority',
                    placeHolder: 'Choose priority position in channels list',
                },
            );
            if (!priorityPick) {
                return;
            }

            const args = ['workspace', 'channel', 'add'];
            if (priorityPick.prepend) {
                args.push('--prepend');
            }
            args.push(targetChannel);

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Adding channel '${targetChannel}' to '${projectName}'...`,
                args,
                projectPath,
                manager,
                `Pixi: Channel '${targetChannel}' added successfully to '${projectName}'.`,
            );
        }),

        // Pixi: Remove Channel...
        commands.registerCommand('pixi.removeChannel', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to remove channel from', folderUri);
            if (!projectPath) {
                return;
            }

            let output = '';
            try {
                output = await runPixi(['workspace', 'channel', 'list'], { cwd: projectPath });
            } catch (err) {
                window.showErrorMessage(`Failed to list channels: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }

            const channels = output
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.startsWith('- '))
                .map((l) => l.substring(2).trim());

            const uniqueChannels = Array.from(new Set(channels));
            if (uniqueChannels.length === 0) {
                window.showInformationMessage('No configurable channels found in this Pixi project.');
                return;
            }

            const selected = await window.showQuickPick(
                uniqueChannels.map((c) => ({
                    label: `$(globe) ${c}`,
                    channel: c,
                })),
                {
                    title: 'Pixi: Remove Channel',
                    placeHolder: 'Select a channel to remove from project manifest',
                },
            );
            if (!selected) {
                return;
            }

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Removing channel '${selected.channel}' from '${projectName}'...`,
                ['workspace', 'channel', 'remove', selected.channel],
                projectPath,
                manager,
                `Pixi: Channel '${selected.channel}' removed successfully from '${projectName}'.`,
            );
        }),
    ];
}
