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
import { getEnvironmentQuickPickInfo, isPixiProject, pickManifestFormat } from './discovery';
import { PixiEnvManager } from './envManager';
import { listPixiPackages, PixiPackageManager } from './packageManager';
import { PixiEnvironment, PixiPackage } from './types';

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

async function pickTargetEnvironment(
    envs: PixiEnvironment[],
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
            const info = getEnvironmentQuickPickInfo(e);
            return {
                label: `${info.icon} ${e.pixiEnvName}`,
                description: info.statusText ? `${e.displayName} ${info.statusText}` : `Environment: ${e.displayName}`,
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

async function pickPythonVersionSpec(): Promise<string | undefined | null> {
    const pythonPick = await window.showQuickPick(
        [
            {
                label: '$(symbol-variable) Python 3.12 (Recommended)',
                description: 'Install Python 3.12',
                version: '3.12',
            },
            {
                label: '$(symbol-variable) Python 3.11',
                description: 'Install Python 3.11',
                version: '3.11',
            },
            {
                label: '$(symbol-variable) Python 3.10',
                description: 'Install Python 3.10',
                version: '3.10',
            },
            {
                label: '$(symbol-variable) Python (Latest)',
                description: 'Install latest available Python',
                version: 'latest',
            },
            {
                label: '$(edit) Custom Version...',
                description: 'Specify custom Python version or constraints',
                version: 'custom',
            },
            {
                label: '$(dash) None (No Python)',
                description: 'Initialize empty environment without Python',
                version: 'none',
            },
        ],
        {
            title: 'Pixi: Select Python Version',
            placeHolder: 'Select Python version for the new environment',
        },
    );
    if (!pythonPick) {
        return null;
    }

    if (pythonPick.version === 'latest') {
        return 'python';
    }
    if (pythonPick.version === 'custom') {
        const custom = await window.showInputBox({
            title: 'Pixi: Custom Python Version',
            placeHolder: 'e.g. 3.11 or >=3.10,<3.12',
            prompt: 'Specify Python package version specifier',
        });
        if (!custom || !custom.trim()) {
            return null;
        }
        return custom.trim().startsWith('python') ? custom.trim() : `python=${custom.trim()}`;
    }
    if (pythonPick.version !== 'none') {
        return `python=${pythonPick.version}`;
    }
    return '';
}

async function pickPixiProject(
    manager: PixiEnvManager,
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
    manager: PixiEnvManager,
    successMsg: string,
    packageManager?: PixiPackageManager,
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
                await packageManager?.clearCache();
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

export function registerWorkspaceCommands(manager: PixiEnvManager, packageManager?: PixiPackageManager): Disposable {
    const disposables: Disposable[] = [];

    // Pixi: Initialize Project...
    disposables.push(
        commands.registerCommand('pixi-python.init', async (folderUri?: Uri) => {
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
                packageManager,
            );

            const createdManifest = format === 'pyproject' ? pyprojectToml : pixiToml;
            await openDocumentIfExists(createdManifest);
        }),
    );

    // Pixi: Create Environment...
    disposables.push(
        commands.registerCommand('pixi-python.createEnvironment', async (folderUri?: Uri) => {
            const targetFolder = await resolveTargetFolder(folderUri, 'Select folder to create Pixi environment in');
            if (!targetFolder) {
                window.showWarningMessage('Please open a folder to create a Pixi environment.');
                return;
            }

            if (isPixiProject(targetFolder)) {
                const action = await window.showQuickPick(
                    [
                        {
                            label: '$(plus) Add New Named Environment...',
                            description: 'Add a new named environment (e.g. dev, test, py311) to this project',
                            action: 'add' as const,
                        },
                        {
                            label: '$(sync) Install / Sync Existing Environments',
                            description: 'Install or sync all environments defined in the manifest',
                            action: 'sync' as const,
                        },
                    ],
                    {
                        title: 'Pixi: Create Environment',
                        placeHolder: `Project manifest exists in ${path.basename(targetFolder)}. Choose an action`,
                    },
                );
                if (!action) {
                    return;
                }

                if (action.action === 'sync') {
                    await commands.executeCommand('pixi-python.install', Uri.file(targetFolder));
                    return;
                }

                const existingEnvs = manager.getEnvironmentsForProject(targetFolder);
                const envName = await window.showInputBox({
                    title: 'Pixi: New Environment Name',
                    prompt: 'Enter a name for the new environment',
                    placeHolder: 'e.g. dev, test, py311',
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
                    packageManager,
                );
            } else {
                const format = await pickManifestFormat();
                if (!format) {
                    return;
                }

                const pythonSpec = await pickPythonVersionSpec();
                if (pythonSpec === null) {
                    return;
                }

                const cmds: string[][] = [['init', '--format', format, '.']];
                if (pythonSpec) {
                    cmds.push(['add', pythonSpec]);
                } else {
                    cmds.push(['install']);
                }

                await runPixiWithProgress(
                    'Pixi: Initializing project and environment...',
                    cmds,
                    targetFolder,
                    manager,
                    pythonSpec
                        ? `Pixi: Environment created and initialized with ${pythonSpec}.`
                        : 'Pixi: Environment created successfully.',
                    packageManager,
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
        commands.registerCommand('pixi-python.deleteEnvironment', async (folderUri?: Uri) => {
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
                    const info = getEnvironmentQuickPickInfo(e);
                    return {
                        label: `${info.icon} ${e.pixiEnvName}`,
                        description: info.statusText
                            ? `${e.displayName} ${info.statusText}`
                            : `Environment: ${e.displayName}`,
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
                    packageManager,
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
                    packageManager,
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
                    packageManager,
                );
            }
        }),
    );

    // Pixi: Install (Sync Environments)
    disposables.push(
        commands.registerCommand('pixi-python.install', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install and sync environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const args = ['install'];
            if (envName) {
                args.push('-e', envName);
            }
            await runPixiWithProgress(
                envName
                    ? `Pixi: Installing environment '${envName}' for ${projectName}...`
                    : `Pixi: Installing environments for ${projectName}...`,
                args,
                projectPath,
                manager,
                envName
                    ? `Pixi: Environment '${envName}' installed successfully for ${projectName}.`
                    : `Pixi: Environments synchronized successfully for ${projectName}.`,
                packageManager,
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
                packageManager,
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
                packageManager,
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
            const targetEnv = await pickTargetEnvironment(envs, 'remove');
            if (targetEnv === null) {
                return;
            }

            const queryEnv = targetEnv || envs[0]?.pixiEnvName || 'default';

            let packages: PixiPackage[];
            try {
                packages = await listPixiPackages(queryEnv, projectPath);
            } catch (error) {
                window.showErrorMessage(`Failed to list packages for project: ${error}`);
                return;
            }

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
                packageManager,
            );
        }),
    );

    return Disposable.from(...disposables);
}
