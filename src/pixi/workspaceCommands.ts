import * as fs from 'fs';
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

import { runPixi } from './cli';
import { isPixiProject } from './discovery';
import { PixiEnvManager } from './envManager';
import { listPixiPackages } from './packageManager';
import { PixiPackage } from './types';

interface ProjectQuickPickItem extends QuickPickItem {
    projectPath: string;
}

interface ChannelQuickPickItem extends QuickPickItem {
    isPypi: boolean;
}

interface ManifestFormatQuickPickItem extends QuickPickItem {
    format: 'pixi' | 'pyproject';
}

interface PackageQuickPickItem extends QuickPickItem {
    pkg: PixiPackage;
}

async function pickPixiProject(
    manager: PixiEnvManager,
    placeHolder: string,
    folderUri?: Uri,
): Promise<string | undefined> {
    if (folderUri?.fsPath) {
        let p = folderUri.fsPath;
        if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
            p = path.dirname(p);
        }
        if (isPixiProject(p)) {
            return p;
        }
    }

    const projectPaths = manager.getProjectPaths();
    if (projectPaths.length === 0) {
        window.showWarningMessage('No Pixi projects found in the current workspace.');
        return undefined;
    }

    if (projectPaths.length === 1) {
        return projectPaths[0];
    }

    const items: ProjectQuickPickItem[] = projectPaths.map((p) => ({
        label: path.basename(p),
        description: p,
        projectPath: p,
    }));

    const selected = await window.showQuickPick(items, {
        placeHolder,
        title: 'Pixi: Select Project',
    });

    return selected?.projectPath;
}

async function runPixiWithProgress(
    title: string,
    args: string[],
    cwd: string,
    manager: PixiEnvManager,
    successMsg: string,
): Promise<void> {
    try {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress, token) => {
                await runPixi(args, { cwd }, token);
                await manager.refresh(undefined);
                window.showInformationMessage(successMsg);
            },
        );
    } catch (error) {
        if (error instanceof CancellationError) {
            return;
        }
        window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
}

export function registerWorkspaceCommands(manager: PixiEnvManager): Disposable {
    const disposables: Disposable[] = [];

    // Pixi: Initialize Project...
    disposables.push(
        commands.registerCommand('pixi-python.init', async (folderUri?: Uri) => {
            let targetFolder: string | undefined;

            if (folderUri?.fsPath) {
                let p = folderUri.fsPath;
                if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
                    p = path.dirname(p);
                }
                targetFolder = p;
            } else if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
                if (workspace.workspaceFolders.length === 1) {
                    targetFolder = workspace.workspaceFolders[0].uri.fsPath;
                } else {
                    const pick = await window.showWorkspaceFolderPick({
                        placeHolder: 'Select folder to initialize Pixi project in',
                    });
                    targetFolder = pick?.uri.fsPath;
                }
            }

            if (!targetFolder) {
                window.showWarningMessage('Please open a folder to initialize a Pixi project.');
                return;
            }

            const pixiToml = path.join(targetFolder, 'pixi.toml');
            const pyprojectToml = path.join(targetFolder, 'pyproject.toml');
            const manifestPath = fs.existsSync(pixiToml)
                ? pixiToml
                : fs.existsSync(pyprojectToml)
                  ? pyprojectToml
                  : undefined;

            if (manifestPath) {
                window.showInformationMessage(
                    `A project manifest (${path.basename(manifestPath)}) already exists in this folder.`,
                );
                const doc = await workspace.openTextDocument(Uri.file(manifestPath));
                await window.showTextDocument(doc);
                return;
            }

            const formatPick = await window.showQuickPick<ManifestFormatQuickPickItem>(
                [
                    {
                        label: '$(file-code) pixi.toml',
                        description: 'Dedicated Pixi manifest format (Recommended)',
                        format: 'pixi',
                    },
                    {
                        label: '$(file) pyproject.toml',
                        description: 'Standard Python pyproject.toml format',
                        format: 'pyproject',
                    },
                ],
                { placeHolder: 'Select manifest format for the new Pixi project' },
            );

            if (!formatPick) {
                return;
            }

            try {
                await runPixi(['init', '--format', formatPick.format, '.'], { cwd: targetFolder });
                manager.markProjectPrompted(targetFolder);
                await commands.executeCommand('setContext', 'pixi-python.hasPixiProject', true);
                await manager.refresh(undefined);

                const createdManifest = formatPick.format === 'pyproject' ? pyprojectToml : pixiToml;
                if (fs.existsSync(createdManifest)) {
                    const doc = await workspace.openTextDocument(Uri.file(createdManifest));
                    await window.showTextDocument(doc);
                }
                window.showInformationMessage('Pixi project initialized successfully.');
            } catch (error) {
                window.showErrorMessage(`Failed to initialize Pixi project: ${error}`);
            }
        }),
    );

    // Pixi: Install (Sync Environments)
    disposables.push(
        commands.registerCommand('pixi-python.install', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install and sync environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Installing environments for ${projectName}...`,
                ['install'],
                projectPath,
                manager,
                `Pixi: Environments synchronized successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Update Dependencies
    disposables.push(
        commands.registerCommand('pixi-python.update', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to update dependencies', folderUri);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Updating dependencies for ${projectName}...`,
                ['update'],
                projectPath,
                manager,
                `Pixi: Dependencies updated successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Add Package...
    disposables.push(
        commands.registerCommand('pixi-python.addPackage', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add package to', folderUri);
            if (!projectPath) {
                return;
            }

            const specInput = await window.showInputBox({
                title: 'Pixi: Add Package',
                prompt: 'Enter package name and version specification (supports multiple packages separated by space)',
                placeHolder: 'e.g. numpy>=1.26 or requests pandas',
                ignoreFocusOut: true,
            });
            if (!specInput || !specInput.trim()) {
                return;
            }
            const specs = specInput.trim().split(/\s+/);

            const channel = await window.showQuickPick<ChannelQuickPickItem>(
                [
                    {
                        label: '$(package) Conda (default)',
                        description: 'Install as Conda package from project channels (writes to [dependencies])',
                        isPypi: false,
                    },
                    {
                        label: '$(symbol-keyword) PyPI',
                        description:
                            'Install as PyPI package from Python Package Index (writes to [pypi-dependencies])',
                        isPypi: true,
                    },
                ],
                {
                    title: 'Pixi: Select Package Channel',
                    placeHolder: 'Choose package source channel',
                },
            );
            if (!channel) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            let targetEnv: string | undefined;
            if (envs.length > 1) {
                const envItems: QuickPickItem[] = [
                    {
                        label: '$(globe) Default',
                        description: 'Add to default feature (available to all environments)',
                    },
                    ...envs.map((e) => ({
                        label: `$(prefix-dev) ${e.pixiEnvName}`,
                        description: `Environment: ${e.displayName}`,
                    })),
                ];
                const selectedEnv = await window.showQuickPick(envItems, {
                    title: 'Pixi: Target Environment (Optional)',
                    placeHolder: 'Select target environment or feature (or press Enter for Default)',
                });
                if (selectedEnv && selectedEnv.label !== '$(globe) Default') {
                    targetEnv = selectedEnv.label.replace('$(prefix-dev) ', '').trim();
                }
            }

            const args = ['add'];
            if (channel.isPypi) {
                args.push('--pypi');
            }
            if (targetEnv) {
                args.push('-e', targetEnv);
            }
            args.push(...specs);

            await runPixiWithProgress(
                `Pixi: Adding ${specs.join(', ')} (${channel.isPypi ? 'PyPI' : 'Conda'})...`,
                args,
                projectPath,
                manager,
                `Pixi: Successfully added ${specs.join(', ')} (${channel.isPypi ? 'PyPI' : 'Conda'}).`,
            );
        }),
    );

    // Pixi: Remove Package...
    disposables.push(
        commands.registerCommand('pixi-python.removePackage', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to remove package from', folderUri);
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const envName = envs[0]?.pixiEnvName || 'default';

            let packages: PixiPackage[];
            try {
                packages = await listPixiPackages(envName, projectPath);
            } catch (error) {
                window.showErrorMessage(`Failed to list packages for project: ${error}`);
                return;
            }

            const explicitPkgs = packages.filter((p) => p.is_explicit);
            const candidates = explicitPkgs.length > 0 ? explicitPkgs : packages;

            if (candidates.length === 0) {
                window.showInformationMessage('No packages found to remove in this project.');
                return;
            }

            const items: PackageQuickPickItem[] = candidates.map((p) => {
                const channelBadge = p.kind === 'pypi' ? '[PyPI]' : '[Conda]';
                return {
                    label: p.name,
                    description: `${channelBadge} ${p.version}`,
                    pkg: p,
                };
            });

            const selected = await window.showQuickPick(items, {
                title: 'Pixi: Remove Package',
                placeHolder: 'Select a package to remove',
                matchOnDescription: true,
            });
            if (!selected) {
                return;
            }

            const isPypi = selected.pkg.kind === 'pypi';
            const args = ['remove'];
            if (isPypi) {
                args.push('--pypi');
            }
            args.push(selected.pkg.name);

            await runPixiWithProgress(
                `Pixi: Removing ${selected.pkg.name}...`,
                args,
                projectPath,
                manager,
                `Pixi: Removed ${selected.pkg.name}.`,
            );
        }),
    );

    return Disposable.from(...disposables);
}
