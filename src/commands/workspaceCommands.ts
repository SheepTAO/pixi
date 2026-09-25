import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, QuickPickItem, Uri, window, workspace } from 'vscode';

import { runPixi } from '../cli/pixiCli';
import { runPixiWithProgress } from '../cli/workspaceCli';
import { isPixiProject } from '../core/projectDiscovery';
import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo, PixiPackage } from '../core/types';

interface ProjectQuickPickItem extends QuickPickItem {
    projectPath: string;
}

export type SourceMode = 'conda' | 'pypi' | 'pypi-custom' | 'path' | 'git';

interface SourceQuickPickItem extends QuickPickItem {
    mode: SourceMode;
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

function normalizeFolderPath(folderUri?: Uri | any): string | undefined {
    if (!folderUri) {
        return undefined;
    }
    if (folderUri.project?.projectPath) {
        return folderUri.project.projectPath;
    }
    if (folderUri.env?.projectPath) {
        return folderUri.env.projectPath;
    }
    if (folderUri.fsPath) {
        let p = folderUri.fsPath;
        if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
            p = path.dirname(p);
        }
        return p;
    }
    return undefined;
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
            const resolvedEnv = (typeof envName === 'string' && envName.trim()) || (folderUri as any)?.env?.pixiEnvName;
            const validEnvName = resolvedEnv ? resolvedEnv.trim() : undefined;
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
            const resolvedEnv = (typeof envName === 'string' && envName.trim()) || (folderUri as any)?.env?.pixiEnvName;
            const validEnvName = resolvedEnv ? resolvedEnv.trim() : undefined;

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

            const source = await window.showQuickPick<SourceQuickPickItem>(
                [
                    {
                        label: '$(package) Conda (default)',
                        description: 'Install as Conda package from project channels (writes to [dependencies])',
                        mode: 'conda',
                    },
                    {
                        label: '$(symbol-keyword) PyPI',
                        description: 'Install from official Python Package Index (writes to [pypi-dependencies])',
                        mode: 'pypi',
                    },
                    {
                        label: '$(globe) PyPI (Custom Index / Mirror...)',
                        description: 'Install from custom PyPI index/mirror (e.g. Tsinghua, Aliyun, private index)',
                        mode: 'pypi-custom',
                    },
                    {
                        label: '$(folder) Local Path / Editable...',
                        description: 'Install a local directory as a path or editable dependency',
                        mode: 'path',
                    },
                    {
                        label: '$(git-branch) Git Repository...',
                        description: 'Install dependency directly from Git repository URL',
                        mode: 'git',
                    },
                ],
                {
                    title: 'Pixi: Select Package Source Channel',
                    placeHolder: 'Choose package source channel or dependency type',
                },
            );
            if (!source) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            const targetEnv = await pickTargetEnvironment(envs, 'add');
            if (targetEnv === null) {
                return;
            }

            const args = ['add'];
            if (targetEnv) {
                args.push('-e', targetEnv);
            }

            let sourceLabel = 'Conda';

            if (source.mode === 'conda') {
                args.push(...specs);
            } else if (source.mode === 'pypi') {
                sourceLabel = 'PyPI';
                args.push('--pypi', ...specs);
            } else if (source.mode === 'pypi-custom') {
                const indexUrl = await window.showInputBox({
                    title: 'Pixi: Custom PyPI Index URL',
                    prompt: 'Enter custom PyPI index/mirror URL',
                    placeHolder: 'https://pypi.tuna.tsinghua.edu.cn/simple',
                    value: 'https://pypi.tuna.tsinghua.edu.cn/simple',
                    ignoreFocusOut: true,
                });
                if (!indexUrl || !indexUrl.trim()) {
                    return;
                }
                sourceLabel = `PyPI [${indexUrl.trim()}]`;
                args.push('--pypi', '--index', indexUrl.trim(), ...specs);
            } else if (source.mode === 'path') {
                const folderUris = await window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select Package Directory',
                    title: 'Pixi: Select Local Package Directory',
                    defaultUri: Uri.file(projectPath),
                });
                if (!folderUris || folderUris.length === 0) {
                    return;
                }
                const selectedDir = folderUris[0].fsPath;
                const relPath = path.relative(projectPath, selectedDir) || '.';

                const modePick = await window.showQuickPick(
                    [
                        {
                            label: '$(edit) Editable Mode (--editable)',
                            description: 'Changes to local source code reflect immediately (PyPI dependency)',
                            isPypi: true,
                            editable: true,
                        },
                        {
                            label: '$(symbol-keyword) PyPI Path Dependency',
                            description: 'Install as standard local PyPI dependency (non-editable)',
                            isPypi: true,
                            editable: false,
                        },
                        {
                            label: '$(package) Conda Path Dependency',
                            description: 'Install as local Conda path dependency',
                            isPypi: false,
                            editable: false,
                        },
                    ],
                    {
                        title: 'Pixi: Select Path Dependency Type',
                        placeHolder: 'Choose installation mode for local directory',
                    },
                );
                if (!modePick) {
                    return;
                }

                if (modePick.isPypi) {
                    args.push('--pypi');
                }
                if (modePick.editable) {
                    args.push('--editable');
                }
                sourceLabel = modePick.editable ? `Editable Path [${relPath}]` : `Path [${relPath}]`;
                args.push(...specs, '--path', relPath);
            } else if (source.mode === 'git') {
                const gitUrl = await window.showInputBox({
                    title: 'Pixi: Git Repository URL',
                    prompt: 'Enter Git repository URL (e.g. https://github.com/org/repo.git)',
                    placeHolder: 'https://github.com/org/repo.git',
                    ignoreFocusOut: true,
                });
                if (!gitUrl || !gitUrl.trim()) {
                    return;
                }

                const rev = await window.showInputBox({
                    title: 'Pixi: Git Branch, Tag, or Revision (Optional)',
                    prompt: 'Enter branch, tag, or commit hash (leave empty for default branch)',
                    placeHolder: 'e.g. main, v1.0.0, or commit hash',
                    ignoreFocusOut: true,
                });

                sourceLabel = `Git [${gitUrl.trim()}]`;
                args.push(...specs, '--git', gitUrl.trim());
                if (rev && rev.trim()) {
                    args.push('--rev', rev.trim());
                }
            }

            await runPixiWithProgress(
                `Pixi: Adding ${specs.join(', ')} (${sourceLabel})...`,
                args,
                projectPath,
                manager,
                `Pixi: Successfully added ${specs.join(', ')} (${sourceLabel}).`,
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

    // Pixi: Add Channel...
    disposables.push(
        commands.registerCommand('pixi.addChannel', async (folderUri?: Uri) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add channel to', folderUri);
            if (!projectPath) {
                return;
            }

            interface ChannelPresetItem extends QuickPickItem {
                channel?: string;
                isCustom?: boolean;
            }

            const presets: ChannelPresetItem[] = [
                {
                    label: '$(globe) Custom Channel Name or URL...',
                    description: 'Enter a custom channel name, internal mirror, or URL',
                    isCustom: true,
                },
                {
                    label: '$(server) conda-forge',
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
                    label: '$(server) bioconda',
                    description: 'Bioinformatics and biology package channel',
                    channel: 'bioconda',
                },
            ];

            const pick = await window.showQuickPick(presets, {
                title: 'Pixi: Add Channel',
                placeHolder: 'Select a channel preset or enter a custom channel / mirror URL',
            });
            if (!pick) {
                return;
            }

            let targetChannel = pick.channel;
            if (pick.isCustom) {
                const input = await window.showInputBox({
                    title: 'Pixi: Enter Channel Name or URL',
                    prompt: 'Enter Conda channel name or URL (e.g. bioconda or https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge)',
                    placeHolder: 'e.g. bioconda or https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge',
                    ignoreFocusOut: true,
                });
                if (!input || !input.trim()) {
                    return;
                }
                targetChannel = input.trim();
            }

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

            await runPixiWithProgress(
                `Pixi: Adding channel '${targetChannel}'...`,
                args,
                projectPath,
                manager,
                `Pixi: Channel '${targetChannel}' added successfully.`,
            );
        }),
    );

    // Pixi: Remove Channel...
    disposables.push(
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

            await runPixiWithProgress(
                `Pixi: Removing channel '${selected.channel}'...`,
                ['workspace', 'channel', 'remove', selected.channel],
                projectPath,
                manager,
                `Pixi: Channel '${selected.channel}' removed successfully.`,
            );
        }),
    );

    disposables.push(
        commands.registerCommand('pixi.refreshProjects', async () => {
            await manager.refresh(undefined);
        }),
    );

    return Disposable.from(...disposables);
}
