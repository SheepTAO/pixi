import * as fs from 'fs';
import * as path from 'path';
import {
    commands,
    Disposable,
    env as vscodeEnv,
    ProgressLocation,
    QuickPickItem,
    Uri,
    window,
    workspace,
} from 'vscode';

import { clearGlobalManifestCache } from '../cli/globalCli';
import { cleanGlobalCache, clearPixiCache, clearSearchCache, runPixi } from '../cli/pixiCli';
import { traceError, traceVerbose } from '../common/logging';
import { PixiInfoTreeDataProvider } from '../views/infoTreeDataProvider';

export async function openLocation(target?: unknown): Promise<void> {
    const targetPath =
        typeof target === 'string'
            ? target
            : target instanceof Uri
              ? target.fsPath
              : target && typeof target === 'object' && 'fsPath' in target
                ? String((target as { fsPath: unknown }).fsPath)
                : undefined;
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

            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: 'Updating Pixi CLI...',
                    cancellable: false,
                },
                async () => {
                    try {
                        traceVerbose('Running pixi self-update...');
                        const output = await runPixi(['self-update'], { includeStderr: true });
                        const lines = output
                            .trim()
                            .split(/\r?\n/)
                            .map((l) => l.trim())
                            .filter(Boolean);
                        const lastLine = lines[lines.length - 1] || output.trim();
                        const cleanOutput = lastLine.replace(/^✔\s*/, '');
                        if (cleanOutput.toLowerCase().includes('already up-to-date')) {
                            window.showInformationMessage(cleanOutput);
                        } else {
                            window.showInformationMessage(`Pixi update: ${cleanOutput}`);
                        }
                        clearPixiCache();
                        clearGlobalManifestCache();
                        clearSearchCache();
                        infoProvider.refresh();
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        traceError('Pixi self-update failed:', err);
                        window.showErrorMessage(`Failed to update Pixi CLI: ${msg}`);
                    }
                },
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

            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: 'Pixi: Cleaning global package cache...',
                    cancellable: false,
                },
                async () => {
                    try {
                        await cleanGlobalCache();
                        infoProvider.refresh();
                        window.showInformationMessage('Pixi: Global package cache cleaned.');
                    } catch (err: unknown) {
                        traceError('Failed to clean package cache:', err);
                        window.showErrorMessage(
                            `Failed to clean cache: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                },
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
