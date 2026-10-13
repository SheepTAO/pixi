import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, env as vscodeEnv, QuickPickItem, Uri, window, workspace } from 'vscode';

import { cleanGlobalCache, clearPixiCache, runPixi } from '../cli/pixiCli';
import { normalizeLocationPath, runWithProgressNotification } from '../common/execUtils';
import { traceVerbose } from '../common/logging';
import { PixiInfoTreeDataProvider } from '../views/infoTreeDataProvider';

export async function openLocation(target?: unknown): Promise<void> {
    const targetPath = normalizeLocationPath(target);
    if (!targetPath) {
        return;
    }
    if (!fs.existsSync(targetPath)) {
        window.showWarningMessage(`Path does not exist: ${targetPath}`);
        return;
    }

    try {
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
            const doc = await workspace.openTextDocument(Uri.file(targetPath));
            await window.showTextDocument(doc);
            return;
        }
    } catch {
        // Ignore stat error and continue
    }

    const isRemote = !!vscodeEnv.remoteName;
    if (isRemote) {
        const items: (QuickPickItem & { action: string })[] = [
            {
                label: '$(terminal) Open in Integrated Terminal',
                description: targetPath,
                action: 'terminal',
            },
            {
                label: '$(copy) Copy Path to Clipboard',
                description: targetPath,
                action: 'copy',
            },
            {
                label: '$(folder) Reveal in File Manager (Client OS)',
                description: 'Attempt to open client OS file manager',
                action: 'reveal',
            },
        ];

        const choice = await window.showQuickPick(items, {
            title: `Pixi Directory: ${path.basename(targetPath)}`,
            placeHolder: 'Select an action for this directory',
        });

        if (!choice) {
            return;
        }

        if (choice.action === 'terminal') {
            const terminal = window.createTerminal({
                name: `Pixi: ${path.basename(targetPath)}`,
                cwd: targetPath,
            });
            terminal.show();
        } else if (choice.action === 'copy') {
            await vscodeEnv.clipboard.writeText(targetPath);
            window.showInformationMessage(`Copied path to clipboard: ${targetPath}`);
        } else if (choice.action === 'reveal') {
            try {
                await commands.executeCommand('revealFileInOS', Uri.file(targetPath));
            } catch {
                window.showWarningMessage('Unable to reveal remote path in client OS file manager.');
            }
        }
        return;
    }

    try {
        await commands.executeCommand('revealFileInOS', Uri.file(targetPath));
    } catch {
        const terminal = window.createTerminal({
            name: `Pixi: ${path.basename(targetPath)}`,
            cwd: targetPath,
        });
        terminal.show();
    }
}

export function registerInfoCommands(infoProvider: PixiInfoTreeDataProvider): Disposable {
    const disposables: Disposable[] = [
        commands.registerCommand('pixi.selfUpdate', async () => {
            const confirm = await window.showInformationMessage(
                'Check for updates and update Pixi CLI to the latest version?',
                { modal: true },
                'Update Pixi CLI',
            );
            if (confirm !== 'Update Pixi CLI') {
                return;
            }

            await runWithProgressNotification(
                'Updating Pixi CLI...',
                async () => {
                    traceVerbose('Running pixi self-update...');
                    const output = await runPixi(['self-update'], { includeStderr: true });
                    clearPixiCache();
                    infoProvider.refresh();
                    return output;
                },
                (output) => {
                    const lines = output
                        .trim()
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                    const lastLine = lines[lines.length - 1] || output.trim();
                    const cleanOutput = lastLine.replace(/^✔\s*/, '');
                    return cleanOutput.toLowerCase().includes('already up-to-date')
                        ? cleanOutput
                        : `Pixi update: ${cleanOutput}`;
                },
                { errorPrefix: 'Failed to update Pixi CLI', cancellable: false },
            );
        }),
        commands.registerCommand('pixi.refreshInfo', () => {
            infoProvider.refresh();
        }),
        commands.registerCommand('pixi.cleanCache', async () => {
            const confirm = await window.showWarningMessage(
                'Are you sure you want to clean the global Pixi package cache? Subsequent installations will re-download packages from the network.',
                { modal: true },
                'Clean Global Cache',
            );
            if (confirm !== 'Clean Global Cache') {
                return;
            }

            await runWithProgressNotification(
                'Pixi: Cleaning global package cache...',
                async (token) => {
                    await cleanGlobalCache(token);
                    infoProvider.refresh();
                },
                'Pixi: Global package cache cleaned.',
                { errorPrefix: 'Failed to clean cache' },
            );
        }),
        commands.registerCommand('pixi.openLocation', (target?: unknown) => {
            return openLocation(target);
        }),
        commands.registerCommand('pixi.measureCacheSize', () => {
            return infoProvider.measureCacheSize();
        }),
    ];

    return Disposable.from(...disposables);
}
