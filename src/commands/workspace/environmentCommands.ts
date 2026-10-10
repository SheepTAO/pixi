import * as fs from 'fs';
import * as path from 'path';
import { commands, ConfigurationTarget, Disposable, QuickPickItem, Uri, window, workspace } from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { revealDefinitionInManifest } from '../../common/execUtils';
import { getEnvironmentStatusBadge } from '../../core/environmentRules';
import { findManifestPath } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import {
    extractCommandContext,
    extractEnvironmentName,
    extractFeatureName,
    getManifestPathForFormat,
    getWorkspaceEnvironments,
    getWorkspaceFeatures,
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
        commands.registerCommand('pixi.init', async (targetItem?: unknown) => {
            const targetFolder = await resolveTargetFolder(targetItem, 'Select folder to initialize Pixi project in');
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

        // Pixi: Create Feature...
        commands.registerCommand('pixi.createFeature', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to create feature in', targetItem);
            if (!projectPath) {
                return;
            }

            const existingFeatures = await getWorkspaceFeatures(projectPath);
            const featureName = await window.showInputBox({
                title: 'Pixi: Create Feature',
                prompt: 'Enter a name for the new feature',
                placeHolder: 'e.g. test, dev, cuda, docs',
                validateInput: (value) => {
                    const trimmed = value?.trim();
                    if (!trimmed) {
                        return 'Feature name cannot be empty.';
                    }
                    if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
                        return 'Feature name must only contain alphanumeric characters, underscores, and hyphens.';
                    }
                    if (trimmed === 'default' || existingFeatures.some((f) => f.name === trimmed)) {
                        return `Feature '${trimmed}' already exists in this project.`;
                    }
                    return null;
                },
            });
            if (!featureName) {
                return;
            }

            const trimmedName = featureName.trim();
            // In Pixi, a feature is created natively via CLI by adding a dependency or task to it.
            // Dispatch to pixi.addPackage with explicit feature scope to run `pixi add -f <feature> <spec>`.
            await commands.executeCommand('pixi.addPackage', Uri.file(projectPath), {
                kind: 'feature',
                name: trimmedName,
            });
        }),

        // Pixi: Create Environment...
        commands.registerCommand('pixi.createEnvironment', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to create environment in',
                targetItem,
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
            const existingFeatures = (await getWorkspaceFeatures(projectPath)).filter((f) => f.name !== 'default');
            const companionFeatureExists = existingFeatures.some((f) => f.name === trimmedName);

            interface EnvModeQuickPickItem {
                label: string;
                description: string;
                action: 'companion' | 'select' | 'empty';
            }

            const modeItems: EnvModeQuickPickItem[] = [];

            if (companionFeatureExists) {
                modeItems.push({
                    label: `$(symbol-namespace) Bind existing feature '${trimmedName}' (Recommended)`,
                    description: `Environment '${trimmedName}' will include existing feature '${trimmedName}'`,
                    action: 'companion',
                });
            } else {
                modeItems.push({
                    label: `$(symbol-namespace) Create with companion feature '${trimmedName}' (Recommended)`,
                    description: `Add initial package to create feature '${trimmedName}' and bind to environment`,
                    action: 'companion',
                });
            }

            if (existingFeatures.length > 0) {
                modeItems.push({
                    label: '$(list-unordered) Select from existing features ...',
                    description: `Assemble '${trimmedName}' using existing features (${existingFeatures.map((f) => f.name).join(', ')})`,
                    action: 'select',
                });
            }

            modeItems.push({
                label: '$(server-environment) Empty environment without features',
                description: `Create standalone '${trimmedName}' without feature bindings`,
                action: 'empty',
            });

            const selectedMode = await window.showQuickPick(modeItems, {
                title: `Pixi: Feature Composition for '${trimmedName}'`,
                placeHolder: 'Select how features should be associated with this environment',
            });

            if (!selectedMode) {
                return;
            }

            if (selectedMode.action === 'companion') {
                if (companionFeatureExists) {
                    await runPixiWithProgress(
                        `Pixi: Creating environment '${trimmedName}' with feature '${trimmedName}'...`,
                        [
                            ['workspace', 'environment', 'add', trimmedName, '--feature', trimmedName],
                            ['install', '-e', trimmedName],
                        ],
                        projectPath,
                        manager,
                        `Pixi: Environment '${trimmedName}' created and ready.`,
                    );
                } else {
                    const initialPkg = await window.showInputBox({
                        title: `Pixi: Companion Feature '${trimmedName}'`,
                        prompt: `Enter initial package(s) to create feature '${trimmedName}' (or press Enter to create without package)`,
                        placeHolder: 'e.g. pytest, python=3.11, ruff',
                    });
                    if (initialPkg === undefined) {
                        return;
                    }
                    const pkgSpec = initialPkg.trim();
                    const commandsToRun: string[][] = [];
                    const pkgs = pkgSpec.split(/[\s,]+/).filter(Boolean);
                    if (pkgs.length > 0) {
                        commandsToRun.push(['add', '-f', trimmedName, ...pkgs]);
                    }
                    commandsToRun.push(
                        [
                            'workspace',
                            'environment',
                            'add',
                            trimmedName,
                            ...(pkgs.length > 0 ? ['--feature', trimmedName] : []),
                        ],
                        ['install', '-e', trimmedName],
                    );
                    await runPixiWithProgress(
                        `Pixi: Creating environment '${trimmedName}'${pkgs.length > 0 ? ` with companion feature '${trimmedName}'` : ''}...`,
                        commandsToRun,
                        projectPath,
                        manager,
                        `Pixi: Environment '${trimmedName}' created and ready.`,
                    );
                }
                return;
            }

            if (selectedMode.action === 'select') {
                const pickedFeatures = await window.showQuickPick(
                    existingFeatures.map((f) => ({
                        label: `$(symbol-namespace) ${f.name}`,
                        description: `${f.dependencies.length + f.pypiDependencies.length} dependencies`,
                        featureName: f.name,
                    })),
                    {
                        title: `Pixi: Select Features for '${trimmedName}'`,
                        placeHolder: 'Select features to include in this environment',
                        canPickMany: true,
                    },
                );
                if (!pickedFeatures || pickedFeatures.length === 0) {
                    return;
                }
                const envAddArgs = [
                    'workspace',
                    'environment',
                    'add',
                    trimmedName,
                    ...pickedFeatures.flatMap((p) => ['--feature', p.featureName]),
                ];
                await runPixiWithProgress(
                    `Pixi: Creating and installing environment '${trimmedName}'...`,
                    [envAddArgs, ['install', '-e', trimmedName]],
                    projectPath,
                    manager,
                    `Pixi: Environment '${trimmedName}' created and ready.`,
                );
                return;
            }

            // empty mode
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
        commands.registerCommand('pixi.deleteEnvironment', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to delete environment from',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const envs = manager.getEnvironmentsForProject(projectPath);
            if (envs.length === 0) {
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
                extractEnvironmentName(targetItem) ??
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
        commands.registerCommand('pixi.lock', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to lock dependencies', targetItem);
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
            const envName = (typeof presetEnv === 'string' && presetEnv.trim()) || extractEnvironmentName(targetItem);
            if (envName) {
                await commands.executeCommand('pixi.install', targetItem, envName);
                return;
            }
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install environment for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }
            const pickedEnv = await pickInstallableEnvironment(
                manager,
                projectPath,
                'Pixi: Install Environment',
                'Select environment to install',
            );
            if (pickedEnv) {
                await commands.executeCommand('pixi.install', Uri.file(projectPath), pickedEnv);
            }
        }),

        // Pixi: Install (Sync Environments)
        commands.registerCommand('pixi.install', async (targetItem?: unknown, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to install and sync environments',
                targetItem,
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
            const envName = (typeof presetEnv === 'string' && presetEnv.trim()) || extractEnvironmentName(targetItem);
            if (envName) {
                await commands.executeCommand('pixi.reinstall', targetItem, envName);
                return;
            }
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to reinstall environment for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }
            const pickedEnv = await pickInstallableEnvironment(
                manager,
                projectPath,
                'Pixi: Reinstall Environment',
                'Select environment to reinstall',
            );
            if (pickedEnv) {
                await commands.executeCommand('pixi.reinstall', Uri.file(projectPath), pickedEnv);
            }
        }),

        // Pixi: Reinstall ...
        commands.registerCommand('pixi.reinstall', async (targetItem?: unknown, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to reinstall environments',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const explicitEnv = (typeof envName === 'string' && envName.trim()) || extractEnvironmentName(targetItem);

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

        // Pixi: Environment Management (Hub)
        commands.registerCommand('pixi.environment', async (targetItem?: unknown) => {
            const actions: Array<{
                label: string;
                description: string;
                command: string;
            }> = [
                {
                    label: '$(plus) Create New Environment...',
                    description: 'Create an environment composed of one or more features',
                    command: 'pixi.createEnvironment',
                },
                {
                    label: '$(sparkle) Create New Feature...',
                    description: 'Create a new feature set in the project manifest',
                    command: 'pixi.createFeature',
                },
                {
                    label: '$(symbol-namespace) Configure Environment Features...',
                    description: 'Manage and update feature bindings for an existing environment',
                    command: 'pixi.configureEnvironmentFeatures',
                },
                {
                    label: '$(cloud-download) Install Environment...',
                    description: 'Install or synchronize dependencies for a specific environment',
                    command: 'pixi.installEnvironment',
                },
                {
                    label: '$(debug-restart) Reinstall Environment...',
                    description: 'Force reinstall of environment prefix (pixi reinstall -e <env>)',
                    command: 'pixi.reinstallEnvironment',
                },
                {
                    label: '$(terminal) Open Terminal in Environment...',
                    description: 'Open a dedicated terminal with the environment activated',
                    command: 'pixi.openTerminal',
                },
                {
                    label: '$(repo-sync) Sync All Environments',
                    description: 'Synchronize all declared environments across the project (pixi install)',
                    command: 'pixi.install',
                },
                {
                    label: '$(debug-restart) Reinstall All Environments...',
                    description: 'Reinstall all environments declared in the project (pixi reinstall --all)',
                    command: 'pixi.reinstall',
                },
                {
                    label: '$(trash) Delete Environment...',
                    description: 'Clean an installed environment prefix on disk',
                    command: 'pixi.deleteEnvironment',
                },
            ];

            const pick = await window.showQuickPick(actions, {
                title: 'Pixi: Environment Management',
                placeHolder: 'Select environment operation',
            });
            if (pick) {
                await commands.executeCommand(pick.command, targetItem);
            }
        }),

        // Pixi: Feature Management (Hub)
        commands.registerCommand('pixi.feature', async (targetItem?: unknown) => {
            const actions: Array<{
                label: string;
                description: string;
                command: string;
            }> = [
                {
                    label: '$(plus) Create New Feature...',
                    description: 'Define a new reusable feature and add initial package(s)',
                    command: 'pixi.createFeature',
                },
                {
                    label: '$(package) Add Package to Feature...',
                    description: 'Install dependencies into a specific feature',
                    command: 'pixi.addPackage',
                },
                {
                    label: '$(go-to-file) Reveal Feature in Manifest',
                    description: 'Jump to feature definition section in pixi.toml / pyproject.toml',
                    command: 'pixi.feature.revealInManifest',
                },
                {
                    label: '$(trash) Remove Feature from Manifest...',
                    description: 'Remove a feature from the project manifest (pixi workspace feature remove)',
                    command: 'pixi.removeFeature',
                },
            ];

            const pick = await window.showQuickPick(actions, {
                title: 'Pixi: Feature Management',
                placeHolder: 'Select feature operation',
            });
            if (pick) {
                await commands.executeCommand(pick.command, targetItem);
            }
        }),

        // Pixi: Configure Features for Environment...
        commands.registerCommand(
            'pixi.configureEnvironmentFeatures',
            async (targetItem?: unknown, presetEnv?: string) => {
                const projectPath = await pickPixiProject(
                    manager,
                    'Select Pixi project to configure environment features for',
                    targetItem,
                );
                if (!projectPath) {
                    return;
                }

                const projectName = path.basename(projectPath);
                let envName = (typeof presetEnv === 'string' && presetEnv.trim()) || extractEnvironmentName(targetItem);
                if (!envName) {
                    const envs = manager.getEnvironmentsForProject(projectPath);
                    const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');
                    if (namedEnvs.length === 0) {
                        window.showInformationMessage(
                            `No custom environments found in ${projectName} to configure features.`,
                        );
                        return;
                    }
                    const pick = await window.showQuickPick(
                        namedEnvs.map((e) => {
                            const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
                            return {
                                label: `${icon} ${e.pixiEnvName}`,
                                description: text,
                                envName: e.pixiEnvName,
                            };
                        }),
                        {
                            title: 'Pixi: Select Environment to Configure Features',
                            placeHolder: 'Select environment',
                        },
                    );
                    if (!pick) {
                        return;
                    }
                    envName = pick.envName;
                }

                const [allFeatures, allEnvs] = await Promise.all([
                    getWorkspaceFeatures(projectPath),
                    getWorkspaceEnvironments(projectPath),
                ]);
                const envEntry = allEnvs.find((e) => e.name === envName);
                const currentBoundFeatures = envEntry?.features || ['default'];

                const featureItems = allFeatures.map((f) => {
                    const isDefault = f.name === 'default';
                    const isBound = currentBoundFeatures.includes(f.name);
                    const depCount = f.dependencies.length + f.pypiDependencies.length;
                    return {
                        label: `$(symbol-namespace) ${f.name}`,
                        description: isDefault ? 'Default global feature' : `${depCount} dependencies`,
                        featureName: f.name,
                        picked: isBound,
                    };
                });

                if (featureItems.length === 0) {
                    window.showInformationMessage(`No features found in ${projectName}.`);
                    return;
                }

                const selected = await window.showQuickPick(featureItems, {
                    title: `Pixi: Configure Features for '${envName}'`,
                    placeHolder: 'Select features to include in this environment (Check/Uncheck)',
                    canPickMany: true,
                });

                if (!selected) {
                    return;
                }

                if (selected.length === 0) {
                    window.showWarningMessage(
                        'An environment must contain at least one feature (or the default feature).',
                    );
                    return;
                }

                const selectedFeatureNames = selected.map((s) => s.featureName);
                const includesDefault = selectedFeatureNames.includes('default');
                const customFeatures = selectedFeatureNames.filter((fn) => fn !== 'default');

                const args = [
                    'workspace',
                    'environment',
                    'add',
                    envName,
                    ...(customFeatures.length > 0
                        ? customFeatures.flatMap((fn) => ['--feature', fn])
                        : includesDefault
                          ? ['--feature', 'default']
                          : []),
                    ...(includesDefault ? [] : ['--no-default-feature']),
                    '--force',
                ];

                await runPixiWithProgress(
                    `Pixi: Updating features for environment '${envName}' in ${projectName}...`,
                    [args, ['install', '-e', envName]],
                    projectPath,
                    manager,
                    `Pixi: Environment '${envName}' updated with features: ${selectedFeatureNames.join(', ') || 'none'}.`,
                );
            },
        ),

        // Pixi: Remove Feature...
        commands.registerCommand('pixi.removeFeature', async (targetItem?: unknown, presetFeature?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to remove feature from',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const allFeatures = (await getWorkspaceFeatures(projectPath)).filter((f) => f.name !== 'default');
            if (allFeatures.length === 0) {
                window.showInformationMessage(`No custom features found in ${projectName} to remove.`);
                return;
            }

            let featureName =
                (typeof presetFeature === 'string' && presetFeature.trim()) || extractFeatureName(targetItem);

            if (!featureName) {
                const pick = await window.showQuickPick(
                    allFeatures.map((f) => ({
                        label: `$(symbol-namespace) ${f.name}`,
                        description: `${f.dependencies.length + f.pypiDependencies.length} dependencies`,
                        featureName: f.name,
                    })),
                    {
                        title: 'Pixi: Remove Feature',
                        placeHolder: 'Select feature to remove from project manifest',
                    },
                );
                if (!pick) {
                    return;
                }
                featureName = pick.featureName;
            }

            if (featureName === 'default') {
                window.showWarningMessage("The 'default' feature cannot be removed.");
                return;
            }

            const allEnvs = await getWorkspaceEnvironments(projectPath);
            const referencingEnvs = allEnvs.filter((e) => e.features?.includes(featureName!)).map((e) => e.name);
            if (referencingEnvs.length > 0) {
                const choice = await window.showWarningMessage(
                    `Feature '${featureName}' is referenced by environment(s): ${referencingEnvs.join(', ')}. Removing it will remove it from the project manifest. Do you want to proceed?`,
                    { modal: true },
                    'Remove Feature',
                );
                if (choice !== 'Remove Feature') {
                    return;
                }
            }

            await runPixiWithProgress(
                `Pixi: Removing feature '${featureName}' from ${projectName}...`,
                ['workspace', 'feature', 'remove', featureName],
                projectPath,
                manager,
                `Pixi: Feature '${featureName}' removed successfully from ${projectName}.`,
            );
        }),

        // Pixi: Reveal Feature in Manifest...
        commands.registerCommand(
            'pixi.feature.revealInManifest',
            async (targetItem?: unknown, presetFeature?: string) => {
                const projectPath = await pickPixiProject(manager, 'Select Pixi project', targetItem);
                if (!projectPath) {
                    return;
                }
                let featureName =
                    (typeof presetFeature === 'string' && presetFeature.trim()) || extractFeatureName(targetItem);
                if (!featureName) {
                    const allFeatures = await getWorkspaceFeatures(projectPath);
                    const pick = await window.showQuickPick(
                        allFeatures.map((f) => ({ label: f.name, featureName: f.name })),
                        { title: 'Select Feature to Reveal' },
                    );
                    if (!pick) {
                        return;
                    }
                    featureName = pick.featureName;
                }

                const manifestPath = findManifestPath(projectPath);
                if (!manifestPath) {
                    return;
                }
                await revealDefinitionInManifest({
                    manifestPath,
                    targetName: featureName,
                    kind: 'feature',
                });
            },
        ),

        // Pixi: Change Grouping...
        commands.registerCommand('pixi.environments.changeGrouping', async () => {
            const config = workspace.getConfiguration('pixi.environments');
            const current = config.get<string>('viewMode', 'environment');

            interface ViewModeQuickPickItem extends QuickPickItem {
                value: 'environment' | 'feature';
            }

            const items: ViewModeQuickPickItem[] = [
                {
                    label: '$(server-environment) Group by Environment',
                    description: 'Group view by environment with feature-nested packages (default)',
                    detail: current === 'environment' ? '(Currently active)' : undefined,
                    value: 'environment',
                },
                {
                    label: '$(symbol-namespace) Group by Feature',
                    description: 'Group view by declared feature with declared dependencies',
                    detail: current === 'feature' ? '(Currently active)' : undefined,
                    value: 'feature',
                },
            ];

            const selected = await window.showQuickPick(items, {
                title: 'Pixi Environments: Change Grouping',
                placeHolder: 'Select how the Environments view should be organized',
            });

            if (selected) {
                const inspect = config.inspect<string>('viewMode');
                const target =
                    inspect?.workspaceFolderValue !== undefined
                        ? ConfigurationTarget.WorkspaceFolder
                        : inspect?.workspaceValue !== undefined
                          ? ConfigurationTarget.Workspace
                          : ConfigurationTarget.Global;
                await config.update('viewMode', selected.value, target);
            }
        }),
        commands.registerCommand('pixi.projects.changeViewMode', async () => {
            await commands.executeCommand('pixi.environments.changeGrouping');
        }),
    ];
}
