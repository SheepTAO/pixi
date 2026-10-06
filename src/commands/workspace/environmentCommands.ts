import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, Uri, window, workspace } from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { getEnvironmentStatusBadge } from '../../core/environmentRules';
import { findManifestPath } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import {
    extractCommandContext,
    extractEnvironmentName,
    getManifestPathForFormat,
    openDocumentIfExists,
    pickManifestFormat,
    pickPixiProject,
    resolveTargetFolder,
} from './common';

async function pickInstallableEnvironment(
    manager: PixiProjectManager,
    projectPath: string,
    title: string,
    placeHolder: string,
): Promise<string | undefined> {
    const projectName = path.basename(projectPath);
    const envs = manager.getEnvironmentsForProject(projectPath);
    const candidateEnvs = envs.filter((e) => e.pixiStatus !== 'incompatible');
    if (candidateEnvs.length === 0) {
        const noun = title.toLowerCase().includes('reinstall') ? 'reinstallable' : 'installable';
        window.showInformationMessage(`No ${noun} environments found in ${projectName}.`);
        return undefined;
    }

    const pick = await window.showQuickPick(
        candidateEnvs.map((e) => {
            const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
            return {
                label: `${icon} ${e.pixiEnvName}`,
                description: text,
                envName: e.pixiEnvName,
            };
        }),
        { title, placeHolder },
    );
    return pick?.envName;
}

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
        commands.registerCommand('pixi.createEnvironment', async (folderUri?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to create environment in',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const existingEnvs = manager.getEnvironmentsForProject(projectPath);
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
                projectPath,
                manager,
                `Pixi: Environment '${trimmedName}' created and ready.`,
            );
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

            const envItems = envs.map((e) => {
                const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
                return {
                    label: `${icon} ${e.pixiEnvName}`,
                    description: text,
                    envName: e.pixiEnvName,
                };
            });

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

            const envName = targetEnvName;
            const targetEnvInfo = envs.find((e) => e.pixiEnvName === envName);
            const isInstalled = targetEnvInfo?.pixiStatus === 'installed';

            if (envName === 'default') {
                const confirmed = await window.showWarningMessage(
                    "Clean the installed 'default' environment on disk? (Can be re-installed using pixi install)",
                    'Clean Environment',
                );
                if (confirmed !== 'Clean Environment') {
                    return;
                }

                await runPixiWithProgress(
                    "Pixi: Cleaning 'default' environment...",
                    ['clean', '-e', 'default'],
                    projectPath,
                    manager,
                    "Pixi: 'default' environment cleaned from disk.",
                );
            } else if (!isInstalled) {
                const confirmed = await window.showWarningMessage(
                    `Remove environment '${envName}' from project manifest?`,
                    'Remove from Manifest',
                );
                if (confirmed !== 'Remove from Manifest') {
                    return;
                }

                await runPixiWithProgress(
                    `Pixi: Removing environment '${envName}' from manifest...`,
                    [['workspace', 'environment', 'remove', envName]],
                    projectPath,
                    manager,
                    `Pixi: Environment '${envName}' removed from manifest.`,
                );
            } else {
                const choice = await window.showWarningMessage(
                    `Delete or clean Pixi environment '${envName}'?`,
                    'Clean from Disk Only',
                    'Delete from Disk & Manifest',
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
                    removeManifest
                        ? `Pixi: Deleting environment '${envName}' from disk and manifest...`
                        : `Pixi: Cleaning environment '${envName}' from disk...`,
                    cmds,
                    projectPath,
                    manager,
                    removeManifest
                        ? `Pixi: Environment '${envName}' deleted from disk and manifest.`
                        : `Pixi: Environment '${envName}' cleaned from disk (definition kept in manifest).`,
                );
            }
        }),

        // Pixi: Clean ...
        commands.registerCommand('pixi.clean', async (targetItem?: unknown) => {
            const choice = await window.showQuickPick(
                [
                    {
                        label: '$(clear-all) Clean Project Environments (.pixi)',
                        description: 'Remove .pixi directory and all installed environments for the project',
                        action: 'project',
                    },
                    {
                        label: '$(trash) Clean Specific Environment...',
                        description: 'Clean an installed environment on disk (pixi clean -e <env>)',
                        action: 'environment',
                    },
                    {
                        label: '$(database) Clean Global Package Cache...',
                        description: 'Clean downloaded package cache in ~/.cache/rattler (pixi clean cache)',
                        action: 'cache',
                    },
                ],
                {
                    title: 'Pixi: Clean',
                    placeHolder: 'Select clean action',
                },
            );
            if (!choice) {
                return;
            }

            if (choice.action === 'cache') {
                await commands.executeCommand('pixi.cleanCache');
                return;
            }

            const projectPath = await pickPixiProject(manager, 'Select Pixi project to clean', targetItem);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);

            if (choice.action === 'environment') {
                const envs = manager.getEnvironmentsForProject(projectPath);
                const installedEnvs = envs.filter((e) => e.pixiStatus === 'installed');
                if (installedEnvs.length === 0) {
                    window.showInformationMessage(`No installed environments found to clean in ${projectName}.`);
                    return;
                }
                const targetEnv = await window.showQuickPick(
                    installedEnvs.map((e) => {
                        const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
                        return {
                            label: `${icon} ${e.pixiEnvName}`,
                            description: text,
                            envName: e.pixiEnvName,
                        };
                    }),
                    {
                        title: `Pixi: Clean Specific Environment (${projectName})`,
                        placeHolder: 'Select an installed environment to clean from disk',
                    },
                );
                if (!targetEnv) {
                    return;
                }

                const confirmed = await window.showWarningMessage(
                    `Clean the installed '${targetEnv.envName}' environment on disk for ${projectName}?`,
                    { modal: true },
                    'Clean Environment',
                );
                if (confirmed !== 'Clean Environment') {
                    return;
                }

                await runPixiWithProgress(
                    `Pixi: Cleaning environment '${targetEnv.envName}' for ${projectName}...`,
                    ['clean', '-e', targetEnv.envName],
                    projectPath,
                    manager,
                    `Pixi: Environment '${targetEnv.envName}' cleaned from disk.`,
                );
                return;
            }

            const pixiDir = path.join(projectPath, '.pixi');
            if (!fs.existsSync(pixiDir)) {
                window.showInformationMessage(
                    `No installed environments found in ${projectName} (.pixi directory does not exist).`,
                );
                return;
            }

            const confirmed = await window.showWarningMessage(
                `Are you sure you want to clean all installed Pixi environments in ${projectName}? (The .pixi directory will be removed)`,
                { modal: true },
                'Clean All',
            );
            if (confirmed !== 'Clean All') {
                return;
            }

            await runPixiWithProgress(
                `Pixi: Cleaning all environments for ${projectName}...`,
                ['clean'],
                projectPath,
                manager,
                `Pixi: All environments cleaned for ${projectName}.`,
            );
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

        // Pixi: Install Environment (Single Environment)
        commands.registerCommand('pixi.installEnvironment', async (targetItem?: unknown, presetEnv?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install environment for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            let envName = (typeof presetEnv === 'string' && presetEnv.trim()) || extractEnvironmentName(targetItem);
            if (!envName) {
                envName = await pickInstallableEnvironment(
                    manager,
                    projectPath,
                    'Pixi: Install Environment',
                    'Select environment to install',
                );
                if (!envName) {
                    return;
                }
            }

            await runPixiWithProgress(
                `Pixi: Installing environment '${envName}' for ${projectName}...`,
                ['install', '-e', envName],
                projectPath,
                manager,
                `Pixi: Environment '${envName}' installed successfully for ${projectName}.`,
            );
        }),

        // Pixi: Install (Sync Environments)
        commands.registerCommand('pixi.install', async (folderUri?: unknown, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install and sync environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const explicitEnv = typeof envName === 'string' && envName.trim() ? envName.trim() : undefined;

            if (explicitEnv) {
                await runPixiWithProgress(
                    `Pixi: Installing environment '${explicitEnv}' for ${projectName}...`,
                    ['install', '-e', explicitEnv],
                    projectPath,
                    manager,
                    `Pixi: Environment '${explicitEnv}' installed successfully for ${projectName}.`,
                );
                return;
            }

            await runPixiWithProgress(
                `Pixi: Synchronizing environments for ${projectName}...`,
                ['install', '--all'],
                projectPath,
                manager,
                `Pixi: Environments synchronized successfully for ${projectName}.`,
            );
        }),

        // Pixi: Reinstall Environment (Single Environment)
        commands.registerCommand('pixi.reinstallEnvironment', async (targetItem?: unknown, presetEnv?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to reinstall environment for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            let envName = (typeof presetEnv === 'string' && presetEnv.trim()) || extractEnvironmentName(targetItem);
            if (!envName) {
                envName = await pickInstallableEnvironment(
                    manager,
                    projectPath,
                    'Pixi: Reinstall Environment',
                    'Select environment to reinstall',
                );
                if (!envName) {
                    return;
                }
            }

            await runPixiWithProgress(
                `Pixi: Re-installing environment '${envName}' for ${projectName}...`,
                ['reinstall', '-e', envName],
                projectPath,
                manager,
                `Pixi: Environment '${envName}' re-installed successfully for ${projectName}.`,
            );
        }),

        // Pixi: Reinstall ...
        commands.registerCommand('pixi.reinstall', async (folderUri?: unknown, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to reinstall environments',
                folderUri,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const explicitEnv = (typeof envName === 'string' && envName.trim()) || extractEnvironmentName(folderUri);

            if (explicitEnv) {
                await runPixiWithProgress(
                    `Pixi: Re-installing environment '${explicitEnv}' for ${projectName}...`,
                    ['reinstall', '-e', explicitEnv],
                    projectPath,
                    manager,
                    `Pixi: Environment '${explicitEnv}' re-installed successfully for ${projectName}.`,
                );
                return;
            }

            const choice = await window.showQuickPick(
                [
                    {
                        label: '$(debug-restart) Reinstall All Environments',
                        description: `Reinstall all environments declared in ${projectName} (pixi reinstall --all)`,
                        action: 'all',
                    },
                    {
                        label: '$(refresh) Reinstall Specific Environment...',
                        description: `Select a single environment to reinstall in ${projectName} (pixi reinstall -e <env>)`,
                        action: 'single',
                    },
                ],
                {
                    title: `Pixi: Reinstall Environments (${projectName})`,
                    placeHolder: 'Select reinstall scope',
                },
            );
            if (!choice) {
                return;
            }

            if (choice.action === 'all') {
                await runPixiWithProgress(
                    `Pixi: Re-installing all environments for ${projectName}...`,
                    ['reinstall', '--all'],
                    projectPath,
                    manager,
                    `Pixi: All environments re-installed successfully for ${projectName}.`,
                );
            } else if (choice.action === 'single') {
                const targetEnv = await pickInstallableEnvironment(
                    manager,
                    projectPath,
                    'Pixi: Reinstall Environment',
                    'Select environment to reinstall',
                );
                if (!targetEnv) {
                    return;
                }
                await runPixiWithProgress(
                    `Pixi: Re-installing environment '${targetEnv}' for ${projectName}...`,
                    ['reinstall', '-e', targetEnv],
                    projectPath,
                    manager,
                    `Pixi: Environment '${targetEnv}' re-installed successfully for ${projectName}.`,
                );
            }
        }),

        // Pixi: Open Manifest (pixi.toml / pyproject.toml)
        commands.registerCommand('pixi.openManifest', async (targetItem?: unknown) => {
            const ctx = extractCommandContext(targetItem);
            let manifestPath = ctx.manifestPath;

            if (!manifestPath) {
                const projectPath =
                    ctx.projectPath ||
                    (await pickPixiProject(manager, 'Select Pixi project to open manifest', targetItem));
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
