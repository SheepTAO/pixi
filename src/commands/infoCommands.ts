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
    let isDirectory = false;
    try {
        isDirectory = fs.statSync(targetPath).isDirectory();
    } catch {
        window.showWarningMessage(`Path does not exist: ${targetPath}`);
        return;
    }

    if (!isDirectory) {
        const doc = await workspace.openTextDocument(Uri.file(targetPath));
        await window.showTextDocument(doc);
        return;
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
    async function executeSelfUpdate(args: string[], title: string): Promise<void> {
        await runWithProgressNotification(
            title,
            async () => {
                traceVerbose(`Running pixi ${args.join(' ')}...`);
                const output = await runPixi(args, { includeStderr: true });
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
    }

    const disposables: Disposable[] = [
        commands.registerCommand('pixi.selfUpdate', async () => {
            interface SelfUpdateChoice extends QuickPickItem {
                action: 'latest' | 'dry-run' | 'version';
            }
            const choices: SelfUpdateChoice[] = [
                {
                    label: '$(cloud-download) Update to Latest Release (Recommended)',
                    description: 'pixi self-update',
                    detail: 'Check for updates and install the newest release of Pixi CLI',
                    action: 'latest',
                },
                {
                    label: '$(file-text) Preview Updates & Release Notes (Dry Run)',
                    description: 'pixi self-update --dry-run',
                    detail: 'Check if a newer version is available and preview release notes without modifying binary',
                    action: 'dry-run',
                },
                {
                    label: '$(history) Install Specific Version...',
                    description: 'pixi self-update --version <VERSION>',
                    detail: 'Upgrade or downgrade Pixi CLI to a target version',
                    action: 'version',
                },
            ];

            const picked = await window.showQuickPick(choices, {
                title: 'Pixi: Update CLI',
                placeHolder: 'Select update mode for Pixi CLI',
            });
            if (!picked) {
                return;
            }

            let args = ['self-update'];
            let title = 'Updating Pixi CLI...';

            if (picked.action === 'dry-run') {
                args = ['self-update', '--dry-run'];
                title = 'Checking for Pixi CLI updates...';
                let dryRunText = '';
                await runWithProgressNotification(
                    title,
                    async () => {
                        dryRunText = await runPixi(args, { includeStderr: true });
                        return dryRunText;
                    },
                    (output) => {
                        const trimmed = output.trim();
                        if (trimmed.toLowerCase().includes('already up-to-date')) {
                            return 'Pixi CLI is already up-to-date.';
                        }
                        return 'Pixi update check completed.';
                    },
                    { errorPrefix: 'Failed to check Pixi CLI updates', cancellable: false },
                );

                if (dryRunText && !dryRunText.toLowerCase().includes('already up-to-date')) {
                    const lines = dryRunText.trim().split(/\r?\n/).filter(Boolean);
                    if (lines.length > 3) {
                        const doc = await workspace.openTextDocument({
                            content: dryRunText,
                            language: 'markdown',
                        });
                        await window.showTextDocument(doc, { preview: true });
                    }
                    const cleanNotice = (lines[0] || dryRunText).replace(/^[ℹ️✔\s]+/, '').trim();
                    const action = await window.showInformationMessage(
                        cleanNotice || 'A newer version of Pixi CLI is available.',
                        'Update Now',
                    );
                    if (action === 'Update Now') {
                        await executeSelfUpdate(['self-update'], 'Updating Pixi CLI to latest release...');
                    }
                }
                return;
            }

            if (picked.action === 'version') {
                const targetVer = await window.showInputBox({
                    title: 'Pixi: Install Specific Version',
                    prompt: 'Enter desired Pixi version',
                    placeHolder: 'e.g. 0.81.0, 0.80.0',
                    validateInput: (v) => (!v.trim() ? 'Version cannot be empty' : null),
                });
                if (!targetVer) {
                    return;
                }
                args = ['self-update', '--version', targetVer.trim()];
                title = `Updating Pixi CLI to v${targetVer.trim()}...`;
            }

            await executeSelfUpdate(args, title);
        }),
        commands.registerCommand('pixi.refreshInfo', () => {
            infoProvider.refresh();
        }),
        commands.registerCommand('pixi.cleanCache', async (presetTarget?: unknown) => {
            interface CacheCleanChoice extends QuickPickItem {
                target: 'all' | 'conda' | 'pypi' | 'repodata' | 'exec' | 'build';
            }
            const choices: CacheCleanChoice[] = [
                {
                    label: '$(trash) Clean All Caches (Default)',
                    description: 'pixi clean cache -y',
                    detail: 'Clean all Conda, PyPI, repodata, build, and temporary exec caches',
                    target: 'all',
                },
                {
                    label: '$(package) Conda Packages Cache',
                    description: 'pixi clean cache --conda -y',
                    detail: 'Clean only downloaded Conda packages and tarballs',
                    target: 'conda',
                },
                {
                    label: '$(symbol-keyword) PyPI Wheels Cache',
                    description: 'pixi clean cache --pypi -y',
                    detail: 'Clean only downloaded PyPI wheels and sdist packages',
                    target: 'pypi',
                },
                {
                    label: '$(database) Repodata Index Cache',
                    description: 'pixi clean cache --repodata -y',
                    detail: 'Clean channel repodata index cache, forcing fresh index download on next solve',
                    target: 'repodata',
                },
                {
                    label: '$(terminal) Temporary Exec Cache',
                    description: 'pixi clean cache --exec -y',
                    detail: 'Clean temporary environments created by `pixi exec`',
                    target: 'exec',
                },
                {
                    label: '$(tools) Build & Backend Cache',
                    description: 'pixi clean cache --build -y',
                    detail: 'Clean pixi-build outputs and build-backend environments cache',
                    target: 'build',
                },
            ];

            let selectedTarget: 'all' | 'conda' | 'pypi' | 'repodata' | 'exec' | 'build' = 'all';
            let targetLabel = 'Global Pixi Cache';

            if (typeof presetTarget === 'string' && choices.some((c) => c.target === presetTarget)) {
                selectedTarget = presetTarget as typeof selectedTarget;
                targetLabel = choices.find((c) => c.target === presetTarget)?.label || presetTarget;
            } else {
                const picked = await window.showQuickPick(choices, {
                    title: 'Pixi: Clean Package Cache',
                    placeHolder: 'Select cache target to clean',
                });
                if (!picked) {
                    return;
                }
                selectedTarget = picked.target;
                targetLabel = picked.label.replace(/\$\([^)]+\)\s*/, '');
            }

            const confirm = await window.showWarningMessage(
                `Are you sure you want to clean ${targetLabel}? Subsequent installations will re-download packages from the network.`,
                { modal: true },
                'Clean Cache',
            );
            if (confirm !== 'Clean Cache') {
                return;
            }

            await runWithProgressNotification(
                `Pixi: Cleaning ${targetLabel}...`,
                async (token) => {
                    await cleanGlobalCache(token, undefined, { target: selectedTarget });
                    infoProvider.refresh();
                },
                `Pixi: ${targetLabel} cleaned.`,
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
