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
import { isPixiProject } from './projectDiscovery';
import { PixiProjectManager } from './projectManager';
import { PixiEnvironmentInfo, PixiPackage } from './types';

interface ProjectQuickPickItem extends QuickPickItem {
    projectPath: string;
}

interface ChannelQuickPickItem extends QuickPickItem {
    isPypi: boolean;
}

interface PackageQuickPickItem extends QuickPickItem {
    pkg: PixiPackage;
}

interface EnvQuickPickItem extends QuickPickItem {
    envName?: string;
}

export async function pickManifestFormat(): Promise<'pixi' | 'pyproject' | undefined> {
    const pick = await window.showQuickPick(
        [
            {
                label: '$(file-code) pixi.toml',
                description: 'Dedicated Pixi manifest format (Recommended)',
                format: 'pixi' as const,
            },
            {
                label: '$(file) pyproject.toml',
                description: 'Standard Python pyproject.toml format',
                format: 'pyproject' as const,
            },
        ],
        { placeHolder: 'Select manifest format for the new Pixi project' },
    );
    return pick?.format;
}

async function pickTargetEnvironment(
    envs: PixiEnvironmentInfo[],
    action: 'add' | 'remove',
): Promise<string | undefined | null> {
    if (envs.length <= 1) {
        return undefined;
    }

    const isAdd = action === 'add';
    const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');
    const items: EnvQuickPickItem[] = [
        {
            label: '$(globe) Default',
            description: `${isAdd ? 'Default environment / feature (available to all environments)' : 'Default environment'}`,
            envName: undefined,
        },
        ...namedEnvs.map((e) => {
            let icon = '$(layers)';
            let statusText = '';
            if (e.pixiStatus === 'uninstalled') {
                icon = '$(cloud-download)';
                statusText = '(not installed)';
            } else if (e.pixiStatus === 'incompatible') {
                icon = '$(circle-slash)';
                statusText = '(incompatible)';
            }
            return {
                label: `${icon} ${e.pixiEnvName}`,
                description: statusText ? `${e.projectName} ${statusText}` : e.projectName,
                envName: e.pixiEnvName,
            };
        }),
    ];

    const selected = await window.showQuickPick(items, {
        title: `Pixi: Target Environment${isAdd ? ' (Optional)' : ''}`,
        placeHolder: `Select target environment or feature to ${action} package`,
    });

    if (!selected) {
        return null;
    }
    return selected.envName;
}

function normalizeFolderPath(folderUri?: Uri): string | undefined {
    if (!folderUri?.fsPath) {
        return undefined;
    }
    let p = folderUri.fsPath;
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
        p = path.dirname(p);
    }
    return p;
}

async function resolveTargetFolder(folderUri?: Uri, placeHolder?: string): Promise<string | undefined> {
    const direct = normalizeFolderPath(folderUri);
    if (direct) {
        return direct;
    }

    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
        return undefined;
    }

    if (workspace.workspaceFolders.length === 1) {
        return workspace.workspaceFolders[0].uri.fsPath;
    }

    const pick = await window.showWorkspaceFolderPick({
        placeHolder: placeHolder || 'Select workspace folder',
    });
    return pick?.uri.fsPath;
}

async function pickPixiProject(
    manager: PixiProjectManager,
    placeHolder: string,
    folderUri?: Uri,
): Promise<string | undefined> {
    const direct = normalizeFolderPath(folderUri);
    const projectPaths = manager.getProjectPaths();

    if (direct) {
        if (isPixiProject(direct)) {
            return direct;
        }
        for (const p of projectPaths) {
            if (direct === p || direct.startsWith(p + path.sep)) {
                return p;
            }
        }
    }

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

async function openDocumentIfExists(filePath: string): Promise<void> {
    if (fs.existsSync(filePath)) {
        const doc = await workspace.openTextDocument(Uri.file(filePath));
        await window.showTextDocument(doc);
    }
}

async function runPixiWithProgress(
    title: string,
    commandsToRun: string[] | string[][],
    cwd: string,
    manager: PixiProjectManager,
    successMsg: string,
): Promise<void> {
    const cmdList: string[][] = Array.isArray(commandsToRun[0])
        ? (commandsToRun as string[][])
        : [commandsToRun as string[]];
    try {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress, token) => {
                for (const args of cmdList) {
                    await runPixi(args, { cwd }, token);
                }
                await manager.refresh(Uri.file(cwd));
                manager.clearPackagesCache(cwd);
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

export function registerWorkspaceCommands(manager: PixiProjectManager): Disposable {
    const disposables: Disposable[] = [];

    // Pixi: Initialize Project...
    disposables.push(
        commands.registerCommand('pixi.init', async (folderUri?: Uri) => {
            const targetFolder = await resolveTargetFolder(folderUri, 'Select folder to initialize Pixi project in');
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

            const format = await pickManifestFormat();
            if (!format) {
                return;
            }

            await runPixiWithProgress(
                'Pixi: Initializing project...',
                ['init', '--format', format, '.'],
                targetFolder,
                manager,
                'Pixi: Project initialized successfully.',
            );

            const createdManifest = format === 'pyproject' ? pyprojectToml : pixiToml;
            await openDocumentIfExists(createdManifest);
        }),
    );

    // Pixi: Create Environment...
    disposables.push(
        commands.registerCommand('pixi.createEnvironment', async (folderUri?: Uri) => {
            const targetFolder = await resolveTargetFolder(folderUri, 'Select folder to create Pixi environment in');
            if (!targetFolder) {
                window.showWarningMessage('Please open a folder to create a Pixi environment.');
                return;
            }

            if (isPixiProject(targetFolder)) {
                const existingEnvs = manager.getEnvironmentsForProject(targetFolder);
                const envName = await window.showInputBox({
                    title: 'Pixi: Create Environment',
                    prompt: 'Enter a name for the new environment',
                    placeHolder: 'e.g. dev, test, native',
                    validateInput: (value) => {
                        const trimmed = value?.trim();
                        if (!trimmed) {
                            return 'Environment name cannot be empty.';
                        }
                        if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
                            return 'Environment name must only contain alphanumeric characters, underscores, and hyphens.';
                        }
                        if (trimmed === 'default' || existingEnvs.some((e) => e.pixiEnvName === trimmed)) {
                            return `Environment '${trimmed}' already exists in this project.`;
                        }
                        return null;
                    },
                });
                if (!envName) {
                    return;
                }

                const trimmedName = envName.trim();
                await runPixiWithProgress(
                    `Pixi: Creating and installing environment '${trimmedName}'...`,
                    [
                        ['workspace', 'environment', 'add', trimmedName],
                        ['install', '-e', trimmedName],
                    ],
                    targetFolder,
                    manager,
                    `Pixi: Environment '${trimmedName}' created and ready.`,
                );
            } else {
                const format = await pickManifestFormat();
                if (!format) {
                    return;
                }

                await runPixiWithProgress(
                    'Pixi: Initializing project and environment...',
                    [['init', '--format', format, '.'], ['install']],
                    targetFolder,
                    manager,
                    'Pixi: Project and default environment initialized successfully.',
                );

                const createdManifest =
                    format === 'pyproject'
                        ? path.join(targetFolder, 'pyproject.toml')
                        : path.join(targetFolder, 'pixi.toml');
                await openDocumentIfExists(createdManifest);
            }
        }),
    );

    // Pixi: Delete Environment...
    disposables.push(
        commands.registerCommand('pixi.deleteEnvironment', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to delete environment from',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const hasPixiDir = fs.existsSync(path.join(projectPath, '.pixi'));
            if (envs.length === 0 && !hasPixiDir) {
                window.showInformationMessage('No installed environments found to delete in this project.');
                return;
            }

            const envItems = [
                ...envs.map((e) => {
                    let icon = '$(layers)';
                    let statusText = '';
                    if (e.pixiStatus === 'uninstalled') {
                        icon = '$(cloud-download)';
                        statusText = '(not installed)';
                    } else if (e.pixiStatus === 'incompatible') {
                        icon = '$(circle-slash)';
                        statusText = '(incompatible)';
                    }
                    return {
                        label: `${icon} ${e.pixiEnvName}`,
                        description: statusText,
                        envName: e.pixiEnvName,
                    };
                }),
                {
                    label: '$(trash) All Environments (.pixi)',
                    description: 'Clean all installed environments in .pixi directory',
                    envName: '__ALL__',
                },
            ];

            const selected = await window.showQuickPick(envItems, {
                title: 'Pixi: Delete Environment',
                placeHolder: 'Select an environment to delete or clean',
            });
            if (!selected) {
                return;
            }

            if (selected.envName === '__ALL__') {
                const confirmed = await window.showWarningMessage(
                    'Are you sure you want to clean all installed Pixi environments in this project? (Can be re-installed using pixi install)',
                    { modal: true },
                    'Clean All',
                );
                if (confirmed !== 'Clean All') {
                    return;
                }

                await runPixiWithProgress(
                    'Pixi: Cleaning all environments...',
                    ['clean'],
                    projectPath,
                    manager,
                    'Pixi: All environments cleaned.',
                );
                return;
            }

            const envName = selected.envName;
            if (envName === 'default') {
                const confirmed = await window.showWarningMessage(
                    "Delete the installed 'default' environment on disk? (Can be re-installed using pixi install)",
                    { modal: true },
                    'Delete',
                );
                if (confirmed !== 'Delete') {
                    return;
                }

                await runPixiWithProgress(
                    "Pixi: Deleting 'default' environment...",
                    ['clean', '-e', 'default'],
                    projectPath,
                    manager,
                    "Pixi: 'default' environment deleted from disk.",
                );
            } else {
                const choice = await window.showWarningMessage(
                    `Delete Pixi environment '${envName}'?`,
                    { modal: true },
                    'Delete from Disk & Manifest',
                    'Clean from Disk Only',
                );
                if (!choice) {
                    return;
                }

                const removeManifest = choice === 'Delete from Disk & Manifest';
                const cmds: string[][] = [['clean', '-e', envName]];
                if (removeManifest) {
                    cmds.push(['workspace', 'environment', 'remove', envName]);
                }
                await runPixiWithProgress(
                    `Pixi: Deleting environment '${envName}'...`,
                    cmds,
                    projectPath,
                    manager,
                    removeManifest
                        ? `Pixi: Environment '${envName}' deleted from disk and manifest.`
                        : `Pixi: Environment '${envName}' cleaned from disk.`,
                );
            }
        }),
    );

    // Pixi: Clean...
    disposables.push(
        commands.registerCommand('pixi.clean', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to clean', folderUri);
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const installedEnvs = envs.filter((e) => e.pixiStatus === 'installed');

            interface CleanQuickPickItem extends QuickPickItem {
                targetKind: 'env' | 'all' | 'global-cache';
                envName?: string;
            }

            const items: CleanQuickPickItem[] = [
                ...installedEnvs.map((e) => ({
                    label: `$(layers) ${e.pixiEnvName}`,
                    description: e.projectName,
                    targetKind: 'env' as const,
                    envName: e.pixiEnvName,
                })),
                {
                    label: '$(trash) All Environments (.pixi)',
                    description: 'Clean all installed environments in this project',
                    targetKind: 'all' as const,
                },
                {
                    label: '$(alert) Global Package Cache',
                    description: 'Clean system-wide package tarball and repodata cache',
                    targetKind: 'global-cache' as const,
                },
            ];

            const selected = await window.showQuickPick(items, {
                title: 'Pixi: Clean',
                placeHolder: 'Select an environment or cache to clean',
            });
            if (!selected) {
                return;
            }

            if (selected.targetKind === 'env') {
                const envName = selected.envName!;
                await runPixiWithProgress(
                    `Pixi: Cleaning environment '${envName}'...`,
                    [['clean', '-e', envName]],
                    projectPath,
                    manager,
                    `Pixi: Environment '${envName}' cleaned.`,
                );
            } else if (selected.targetKind === 'all') {
                await runPixiWithProgress(
                    'Pixi: Cleaning all environments...',
                    [['clean']],
                    projectPath,
                    manager,
                    'Pixi: All environments cleaned in this project.',
                );
            } else if (selected.targetKind === 'global-cache') {
                const confirmed = await window.showWarningMessage(
                    'Are you sure you want to clean the global Pixi package cache? Subsequent installations will re-download packages from the network.',
                    { modal: true },
                    'Clean Global Cache',
                );
                if (confirmed !== 'Clean Global Cache') {
                    return;
                }

                await runPixiWithProgress(
                    'Pixi: Cleaning global package cache...',
                    [['clean', 'cache', '-y']],
                    projectPath,
                    manager,
                    'Pixi: Global package cache cleaned.',
                );
            }
        }),
    );

    // Pixi: Lock Dependencies
    disposables.push(
        commands.registerCommand('pixi.lock', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to lock dependencies', folderUri);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            await runPixiWithProgress(
                `Pixi: Solving and locking dependencies for ${projectName}...`,
                ['lock'],
                projectPath,
                manager,
                `Pixi: Lockfile (pixi.lock) updated successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Install (Sync Environments)
    disposables.push(
        commands.registerCommand('pixi.install', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install and sync environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const validEnvName = typeof envName === 'string' && envName.trim() ? envName.trim() : undefined;
            const args = ['install'];
            if (validEnvName) {
                args.push('-e', validEnvName);
            }
            await runPixiWithProgress(
                validEnvName
                    ? `Pixi: Installing environment '${validEnvName}' for ${projectName}...`
                    : `Pixi: Installing environments for ${projectName}...`,
                args,
                projectPath,
                manager,
                validEnvName
                    ? `Pixi: Environment '${validEnvName}' installed successfully for ${projectName}.`
                    : `Pixi: Environments synchronized successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Reinstall Environment...
    disposables.push(
        commands.registerCommand('pixi.reinstall', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to reinstall environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const validEnvName = typeof envName === 'string' && envName.trim() ? envName.trim() : undefined;

            const runReinstall = async (target?: string, isAll?: boolean) => {
                const title = target
                    ? `Pixi: Re-installing environment '${target}' for ${projectName}...`
                    : isAll
                      ? `Pixi: Re-installing all environments for ${projectName}...`
                      : `Pixi: Re-installing environments for ${projectName}...`;
                const args = target ? ['reinstall', '-e', target] : isAll ? ['reinstall', '--all'] : ['reinstall'];
                const successMsg = target
                    ? `Pixi: Environment '${target}' re-installed successfully for ${projectName}.`
                    : isAll
                      ? `Pixi: All environments re-installed successfully for ${projectName}.`
                      : `Pixi: Environments re-installed successfully for ${projectName}.`;
                await runPixiWithProgress(title, args, projectPath, manager, successMsg);
            };

            if (validEnvName) {
                return runReinstall(validEnvName);
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const validEnvs = envs.filter((e) => e.pixiStatus !== 'incompatible');

            if (validEnvs.length <= 1) {
                return runReinstall(validEnvs[0]?.pixiEnvName);
            }

            interface ReinstallQuickPickItem extends QuickPickItem {
                targetKind: 'env' | 'all';
                envName?: string;
            }

            const items: ReinstallQuickPickItem[] = [
                ...validEnvs.map((e) => ({
                    label: `$(layers) ${e.pixiEnvName}`,
                    description: e.projectName,
                    targetKind: 'env' as const,
                    envName: e.pixiEnvName,
                })),
                {
                    label: '$(sync) All Environments',
                    description: `Re-install all environments in ${projectName}`,
                    targetKind: 'all' as const,
                },
            ];

            const selected = await window.showQuickPick(items, {
                title: 'Pixi: Reinstall Environment',
                placeHolder: `Select an environment to reinstall in ${projectName}`,
            });
            if (!selected) {
                return;
            }

            if (selected.targetKind === 'env') {
                return runReinstall(selected.envName);
            } else {
                return runReinstall(undefined, true);
            }
        }),
    );

    // Pixi: Update Dependencies
    disposables.push(
        commands.registerCommand('pixi.update', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to update dependencies', folderUri);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const validEnvName = typeof envName === 'string' && envName.trim() ? envName.trim() : undefined;
            const args = ['update'];
            if (validEnvName) {
                args.push('-e', validEnvName);
            }
            await runPixiWithProgress(
                validEnvName
                    ? `Pixi: Updating dependencies for environment '${validEnvName}' in ${projectName}...`
                    : `Pixi: Updating dependencies for ${projectName}...`,
                args,
                projectPath,
                manager,
                validEnvName
                    ? `Pixi: Dependencies updated successfully for environment '${validEnvName}' in ${projectName}.`
                    : `Pixi: Dependencies updated successfully for ${projectName}.`,
            );
        }),
    );

    // Pixi: Add Package...
    disposables.push(
        commands.registerCommand('pixi.addPackage', async (folderUri?: Uri) => {
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
            const targetEnv = await pickTargetEnvironment(envs, 'add');
            if (targetEnv === null) {
                return;
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
        commands.registerCommand('pixi.removePackage', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to remove package from', folderUri);
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const targetEnv = await pickTargetEnvironment(envs, 'remove');
            if (targetEnv === null) {
                return;
            }

            const queryEnv = targetEnv || envs[0]?.pixiEnvName || 'default';

            const packages = await manager.getPackagesForEnvironment(queryEnv, projectPath);

            const explicitPkgs = packages.filter((p) => p.is_explicit);
            const candidates = explicitPkgs.length > 0 ? explicitPkgs : packages;

            if (candidates.length === 0) {
                window.showInformationMessage(`No packages found to remove in environment '${queryEnv}'.`);
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
                placeHolder: `Select a package to remove from '${queryEnv}'`,
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
            if (targetEnv) {
                args.push('-e', targetEnv);
            }
            args.push(selected.pkg.name);

            const envLabel = targetEnv ? ` (${targetEnv})` : '';
            await runPixiWithProgress(
                `Pixi: Removing ${selected.pkg.name}${envLabel}...`,
                args,
                projectPath,
                manager,
                `Pixi: Removed ${selected.pkg.name}${envLabel}.`,
            );
        }),
    );

    return Disposable.from(...disposables);
}
