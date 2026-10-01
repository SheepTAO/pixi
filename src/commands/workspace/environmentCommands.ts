import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, QuickPickItem, Uri, window, workspace } from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { normalizeFolderPath } from '../../common/execUtils';
import { getEnvironmentStatusBadge } from '../../core/environmentRules';
import { findManifestPath, isPixiProject } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import {
    extractEnvironmentName,
    getManifestPathForFormat,
    openDocumentIfExists,
    pickManifestFormat,
    pickPixiProject,
    resolveTargetFolder,
} from './common';

export function registerEnvironmentCommands(manager: PixiProjectManager): Disposable[] {
    return [
        // Pixi: Initialize Project...
        commands.registerCommand('pixi.init', async (folderUri?: Uri) => {
            const targetFolder = await resolveTargetFolder(folderUri, 'Select folder to initialize Pixi project in');
            if (!targetFolder) {
                window.showWarningMessage('Please open a folder to initialize a Pixi project.');
                return;
            }

            const manifestPath = findManifestPath(targetFolder);

            if (manifestPath) {
                window.showInformationMessage(
                    `A project manifest (${path.basename(manifestPath)}) already exists in this folder.`,
                );
                const doc = await workspace.openTextDocument(Uri.file(manifestPath));
                await window.showTextDocument(doc);
                return;
            }

            const format = await pickManifestFormat(targetFolder);
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

            await openDocumentIfExists(getManifestPathForFormat(targetFolder, format));
        }),

        // Pixi: Create Environment...
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
                const format = await pickManifestFormat(targetFolder);
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

                await openDocumentIfExists(getManifestPathForFormat(targetFolder, format));
            }
        }),

        // Pixi: Delete Environment...
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
                    const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
                    return {
                        label: `${icon} ${e.pixiEnvName}`,
                        description: text,
                        envName: e.pixiEnvName,
                    };
                }),
                {
                    label: '$(trash) All Environments (.pixi)',
                    description: 'Clean all installed environments in .pixi directory',
                    envName: '__ALL__',
                },
            ];

            const targetEnvName =
                extractEnvironmentName(folderUri) ??
                (
                    await window.showQuickPick(envItems, {
                        title: 'Pixi: Delete Environment',
                        placeHolder: 'Select an environment to delete or clean',
                    })
                )?.envName;

            if (!targetEnvName) {
                return;
            }

            if (targetEnvName === '__ALL__') {
                const confirmed = await window.showWarningMessage(
                    'Are you sure you want to clean all installed Pixi environments in this project? (Can be re-installed using pixi install)',
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

            const envName = targetEnvName;
            if (envName === 'default') {
                const confirmed = await window.showWarningMessage(
                    "Delete the installed 'default' environment on disk? (Can be re-installed using pixi install)",
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

        // Pixi: Clean...
        commands.registerCommand('pixi.clean', async (target?: unknown) => {
            const envName = extractEnvironmentName(target);
            const targetProjectPath = normalizeFolderPath(target);
            if (envName && targetProjectPath) {
                const confirmed = await window.showWarningMessage(
                    `Are you sure you want to clean installed environment '${envName}' on disk?`,
                    'Clean Environment',
                );
                if (confirmed === 'Clean Environment') {
                    await runPixiWithProgress(
                        `Pixi: Cleaning environment '${envName}'...`,
                        ['clean', '-e', envName],
                        targetProjectPath,
                        manager,
                        `Pixi: Environment '${envName}' cleaned.`,
                    );
                }
                return;
            }

            const projectPath = await pickPixiProject(manager, 'Select Pixi project to clean', target);
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
                    ['clean', '-e', envName],
                    projectPath,
                    manager,
                    `Pixi: Environment '${envName}' cleaned.`,
                );
            } else if (selected.targetKind === 'all') {
                await runPixiWithProgress(
                    'Pixi: Cleaning all environments...',
                    ['clean'],
                    projectPath,
                    manager,
                    'Pixi: All environments cleaned in this project.',
                );
            } else if (selected.targetKind === 'global-cache') {
                await commands.executeCommand('pixi.cleanCache');
            }
        }),

        // Pixi: Lock Dependencies
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

        // Pixi: Install (Sync Environments)
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
            const validEnvName = extractEnvironmentName(envName, folderUri);
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

        // Pixi: Reinstall Environment...
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
            const validEnvName = extractEnvironmentName(envName, folderUri);

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

        // Pixi: Update Dependencies
        commands.registerCommand('pixi.update', async (folderUri?: Uri, envName?: string) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to update dependencies', folderUri);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const validEnvName = extractEnvironmentName(envName, folderUri);
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

        // Pixi: Open Manifest (pixi.toml / pyproject.toml)
        commands.registerCommand('pixi.openManifest', async (targetItem?: unknown) => {
            interface ManifestCandidate {
                manifestPath?: string;
                project?: { manifestPath?: string };
                env?: { manifestPath?: string };
            }
            const item = targetItem as ManifestCandidate | undefined;
            let manifestPath: string | undefined =
                item?.manifestPath || item?.project?.manifestPath || item?.env?.manifestPath;

            if (!manifestPath) {
                const projectPath = await pickPixiProject(manager, 'Select Pixi project to open manifest', targetItem);
                if (!projectPath) {
                    return;
                }
                manifestPath = manager.getManifestPath(projectPath);
            }

            if (!manifestPath || !fs.existsSync(manifestPath)) {
                window.showWarningMessage('Could not find manifest file for this project.');
                return;
            }

            try {
                const doc = await workspace.openTextDocument(Uri.file(manifestPath));
                await window.showTextDocument(doc);
            } catch (err) {
                window.showErrorMessage(`Failed to open manifest: ${err instanceof Error ? err.message : String(err)}`);
            }
        }),

        // Pixi: Refresh Projects
        commands.registerCommand('pixi.refreshProjects', async () => {
            await manager.refresh(undefined);
        }),
    ];
}
