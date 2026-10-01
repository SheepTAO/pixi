import * as path from 'path';
import { commands, Disposable, Uri, window } from 'vscode';

import { promptCondaChannel, runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { PixiProjectManager } from '../../core/projectManager';
import { pickPixiProject } from './common';

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
