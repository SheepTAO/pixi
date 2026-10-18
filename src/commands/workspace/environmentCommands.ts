import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, FileType, ProgressLocation, QuickPickItem, Uri, window, workspace } from 'vscode';

import { runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { revealDefinitionInManifest } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import {
    extractCommandContext,
    extractEnvironmentName,
    extractFeatureName,
    filterNamedFeatures,
    formatScope,
    getManifestPathForFormat,
    getReferencingEnvs,
    getScopeArgs,
    getWorkspaceEnvironments,
    getWorkspaceFeatures,
    openDocumentIfExists,
    pickManifestFormat,
    pickPixiFeature,
    pickPixiProject,
    pickProjectEnvironmentName,
    pickTargetScope,
    promptNewFeatureName,
    resolveTargetFolder,
    toFeatureQuickPickItem,
    updateConfigurationValue,
    validatePixiIdentifier,
} from './common';

async function pickInstallableEnvironment(
    manager: PixiProjectManager,
    projectPath: string,
    title: string,
    placeHolder: string,
): Promise<string | undefined> {
    const projectName = manager.getProjectName(projectPath);
    const noun = title.toLowerCase().includes('reinstall') ? 'reinstallable' : 'installable';
    return pickProjectEnvironmentName(manager, projectPath, {
        title,
        placeHolder,
        filter: (e) => e.pixiStatus !== 'incompatible',
        emptyMessage: `No ${noun} environments found in ${projectName}.`,
    });
}

async function runSingleEnvironmentInstallCommand(
    manager: PixiProjectManager,
    action: 'install' | 'reinstall',
    targetItem?: unknown,
    presetEnv?: string,
): Promise<void> {
    const handler = action === 'reinstall' ? handleReinstallCommand : handleInstallCommand;
    const envName = extractEnvironmentName(targetItem, presetEnv);
    if (envName) {
        await handler(manager, targetItem, envName);
        return;
    }

    const projectPath = await pickPixiProject(manager, `Select Pixi project to ${action} environment for`, targetItem);
    if (!projectPath) {
        return;
    }

    const title = action === 'reinstall' ? 'Pixi: Reinstall Environment' : 'Pixi: Install Environment';
    const pickedEnv = await pickInstallableEnvironment(manager, projectPath, title, `Select environment to ${action}`);
    if (pickedEnv) {
        await handler(manager, Uri.file(projectPath), pickedEnv);
    }
}

async function handleInitCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const targetFolder = await resolveTargetFolder(targetItem, 'Select folder to initialize Pixi project in');
    if (!targetFolder) {
        window.showWarningMessage('Please open a folder to initialize a Pixi project.');
        return;
    }

    const manifestPath = manager.getManifestPath(targetFolder);

    if (manifestPath) {
        window.showInformationMessage(
            `A project manifest (${path.basename(manifestPath)}) already exists in this folder.`,
        );
        await openDocumentIfExists(manifestPath);
        return;
    }

    const initMode = await window.showQuickPick(
        [
            {
                label: '$(file-code) Standard Workspace',
                description: 'Initialize a standard empty Pixi workspace',
                mode: 'standard' as const,
            },
            {
                label: '$(cloud-download) Import Conda Environment File...',
                description: 'Bootstrap workspace from an existing environment.yml file (--import)',
                mode: 'import' as const,
            },
        ],
        {
            title: 'Pixi: Initialize Workspace',
            placeHolder: 'Select initialization mode',
        },
    );
    if (!initMode) {
        return;
    }

    let importFilePath: string | undefined;
    if (initMode.mode === 'import') {
        const pickedUris = await window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Import Conda Environment',
            title: 'Select environment.yml to import',
            filters: {
                'Conda Environment': ['yml', 'yaml'],
                'All Files': ['*'],
            },
            defaultUri: Uri.file(targetFolder),
        });
        if (!pickedUris || pickedUris.length === 0) {
            return;
        }
        importFilePath = pickedUris[0].fsPath;
    }

    const format = await pickManifestFormat(targetFolder);
    if (!format) {
        return;
    }

    const initArgs = ['init', '--format', format];
    if (importFilePath) {
        initArgs.push('--import', importFilePath);
    }
    initArgs.push('.');

    const title = importFilePath
        ? `Pixi: Initializing project from ${path.basename(importFilePath)}...`
        : 'Pixi: Initializing project...';
    const successMsg = importFilePath
        ? `Pixi: Project initialized successfully from ${path.basename(importFilePath)}.`
        : 'Pixi: Project initialized successfully.';

    await runPixiWithProgress(title, initArgs, targetFolder, manager, successMsg);

    await openDocumentIfExists(getManifestPathForFormat(targetFolder, format));
}

async function handleImportCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    // 1. Resolve candidate file
    let filePath: string | undefined;
    if (targetItem instanceof Uri) {
        try {
            const stat = await workspace.fs.stat(targetItem);
            if ((stat.type & FileType.File) !== 0) {
                filePath = targetItem.fsPath;
            }
        } catch {
            // Ignore
        }
    } else if (typeof targetItem === 'string') {
        try {
            if (fs.statSync(targetItem).isFile()) {
                filePath = targetItem;
            }
        } catch {
            // Ignore
        }
    }

    if (!filePath) {
        const defaultUri =
            targetItem instanceof Uri
                ? targetItem
                : typeof targetItem === 'string'
                  ? Uri.file(targetItem)
                  : (workspace.workspaceFolders?.[0]?.uri ?? undefined);
        const pickedUris = await window.showOpenDialog({
            canSelectMany: false,
            canSelectFolders: false,
            canSelectFiles: true,
            openLabel: 'Import into Pixi',
            title: 'Select Environment or Requirements File to Import',
            defaultUri,
            filters: {
                'Dependency Files (*.txt, *.in, *.yml, *.yaml)': ['txt', 'in', 'yml', 'yaml'],
                'PyPI Requirements (*.txt, *.in)': ['txt', 'in'],
                'Conda Environment (*.yml, *.yaml)': ['yml', 'yaml'],
                'All Files': ['*'],
            },
        });
        if (!pickedUris || pickedUris.length === 0) {
            return;
        }
        filePath = pickedUris[0].fsPath;
    }

    // 2. Resolve Pixi project
    let projectPath = manager.findProjectForUri(Uri.file(filePath));
    if (!projectPath) {
        projectPath = await pickPixiProject(manager, 'Select Pixi project to import dependencies into', targetItem);
    }
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);

    // 3. Determine format
    const ext = path.extname(filePath).toLowerCase();
    let format: 'conda-env' | 'pypi-txt' | undefined;
    if (ext === '.txt' || ext === '.in') {
        format = 'pypi-txt';
    } else if (ext === '.yml' || ext === '.yaml') {
        format = 'conda-env';
    } else {
        interface FormatPickItem extends QuickPickItem {
            format?: 'pypi-txt' | 'conda-env';
        }
        const formatPick = await window.showQuickPick<FormatPickItem>(
            [
                {
                    label: '$(symbol-keyword) PyPI Requirements (requirements.txt / .in)',
                    description: 'Interpret as Python package requirements (--format pypi-txt)',
                    format: 'pypi-txt',
                },
                {
                    label: '$(package) Conda Environment (environment.yml)',
                    description: 'Interpret as Conda environment definition (--format conda-env)',
                    format: 'conda-env',
                },
                {
                    label: '$(sparkle) Auto-detect Format',
                    description: 'Let Pixi test both formats automatically',
                    format: undefined,
                },
            ],
            {
                title: `Pixi: Select Import Format for '${path.basename(filePath)}'`,
                placeHolder: 'Select the file format to interpret dependencies as',
            },
        );
        if (!formatPick) {
            return;
        }
        format = formatPick.format;
    }

    // 4. Resolve Target Scope (default / feature / environment)
    const envs = manager.getEnvironmentsForProject(projectPath);
    const targetScope = await pickTargetScope(projectPath, envs, undefined, {
        allowWorkspaceDependencies: false,
        title: `Pixi: Import Target Scope (${projectName})`,
        placeHolder: `Select where to import dependencies from '${path.basename(filePath)}'`,
    });
    if (!targetScope) {
        return;
    }

    const args = ['import', filePath];
    if (format) {
        args.push('--format', format);
    }

    if (targetScope.kind === 'global') {
        args.push('-f', 'default');
    } else {
        args.push(...getScopeArgs(targetScope));
    }

    const scopeDesc = formatScope(targetScope);
    const fileName = path.basename(filePath);
    await runPixiWithProgress(
        `Pixi: Importing '${fileName}' into ${scopeDesc} (${projectName})...`,
        args,
        projectPath,
        manager,
        `Pixi: Successfully imported '${fileName}' into ${scopeDesc} (${projectName}).`,
    );
}

async function handleCreateFeatureCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to create feature in', targetItem);
    if (!projectPath) {
        return;
    }

    const existingFeatures = await getWorkspaceFeatures(projectPath);
    const trimmedName = await promptNewFeatureName(existingFeatures);
    if (!trimmedName) {
        return;
    }

    // In Pixi, a feature is created natively via CLI by adding a dependency or task to it.
    // Dispatch to pixi.addPackage with explicit feature scope to run `pixi add -f <feature> <spec>`.
    await commands.executeCommand('pixi.addPackage', Uri.file(projectPath), {
        kind: 'feature',
        name: trimmedName,
    });
}

async function handleCreateEnvironmentCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to create environment in', targetItem);
    if (!projectPath) {
        return;
    }

    const existingEnvs = manager.getEnvironmentsForProject(projectPath);
    const envName = await window.showInputBox({
        title: 'Pixi: Create Environment',
        prompt: 'Enter a name for the new environment',
        placeHolder: 'e.g. dev, test, native',
        validateInput: (value) =>
            validatePixiIdentifier(value, {
                entityName: 'Environment',
                existingNames: existingEnvs.map((e) => e.pixiEnvName),
            }),
    });
    if (!envName) {
        return;
    }

    const trimmedName = envName.trim();
    const existingFeatures = filterNamedFeatures(await getWorkspaceFeatures(projectPath));
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

    // Optional Solve Group selection (Pixi 0.80+)
    const existingSolveGroups = Array.from(
        new Set(existingEnvs.map((e) => e.solveGroup).filter((g): g is string => Boolean(g))),
    );
    interface SolveGroupPickItem extends QuickPickItem {
        groupName?: string;
        isNew?: boolean;
    }
    const solveGroupItems: SolveGroupPickItem[] = [
        {
            label: '$(circle-slash) No Solve Group (Default)',
            description: 'Environment solves independently',
            groupName: undefined,
        },
        ...existingSolveGroups.map((g) => ({
            label: `$(layers) ${g}`,
            description: `Join existing solve group '${g}'`,
            groupName: g,
        })),
        {
            label: '$(plus) New Solve Group...',
            description: 'Create and join a new solve group',
            isNew: true,
        },
    ];

    const pickedGroupItem = await window.showQuickPick(solveGroupItems, {
        title: `Pixi: Solve Group for '${trimmedName}' (Optional)`,
        placeHolder: 'Select a solve group or skip for independent environment',
    });
    if (!pickedGroupItem) {
        return;
    }

    let selectedSolveGroup: string | undefined = pickedGroupItem.groupName;
    if (pickedGroupItem.isNew) {
        const newGroupName = await window.showInputBox({
            title: `Pixi: New Solve Group for '${trimmedName}'`,
            prompt: 'Enter solve group name (leave empty to skip solve group)',
            placeHolder: 'e.g. prod, test, py311',
        });
        if (newGroupName === undefined) {
            return;
        }
        selectedSolveGroup = newGroupName.trim() || undefined;
    }

    const solveGroupArgs = selectedSolveGroup ? ['--solve-group', selectedSolveGroup] : [];

    if (selectedMode.action === 'companion') {
        if (companionFeatureExists) {
            await runPixiWithProgress(
                `Pixi: Creating environment '${trimmedName}' with feature '${trimmedName}'...`,
                [
                    ['workspace', 'environment', 'add', trimmedName, '--feature', trimmedName, ...solveGroupArgs],
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
                    ...solveGroupArgs,
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
        const pickedFeatures = await window.showQuickPick(existingFeatures.map(toFeatureQuickPickItem), {
            title: `Pixi: Select Features for '${trimmedName}'`,
            placeHolder: 'Select features to include in this environment',
            canPickMany: true,
        });
        if (!pickedFeatures || pickedFeatures.length === 0) {
            return;
        }
        const envAddArgs = [
            'workspace',
            'environment',
            'add',
            trimmedName,
            ...pickedFeatures.flatMap((p) => ['--feature', p.featureName]),
            ...solveGroupArgs,
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
            ['workspace', 'environment', 'add', trimmedName, ...solveGroupArgs],
            ['install', '-e', trimmedName],
        ],
        projectPath,
        manager,
        `Pixi: Environment '${trimmedName}' created and ready.`,
    );
}

async function handleDeleteEnvironmentCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    presetEnv?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to delete environment from', targetItem);
    if (!projectPath) {
        return;
    }

    const envs = manager.getEnvironmentsForProject(projectPath);
    if (envs.length === 0) {
        window.showInformationMessage('No environments found in this project.');
        return;
    }

    const envName =
        extractEnvironmentName(targetItem, presetEnv) ??
        (await pickProjectEnvironmentName(manager, projectPath, {
            title: 'Pixi: Delete Environment',
            placeHolder: 'Select an environment to delete or clean',
        }));

    if (!envName) {
        return;
    }

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
}

async function handleCleanCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
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
                label: '$(zap) Clean Activation Scripts Cache',
                description: 'Remove cached activation scripts (pixi clean --activation-cache)',
                action: 'activation-cache',
            },
            {
                label: '$(tools) Clean Pixi Build Cache',
                description: 'Remove pixi-build cache in project (pixi clean --build)',
                action: 'build-cache',
            },
            {
                label: '$(archive) Clean Disassociated Workspace Registries',
                description: 'Remove stale project paths from machine registry (pixi clean --workspaces-registry)',
                action: 'workspaces-registry',
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

    const projectName = manager.getProjectName(projectPath);

    if (choice.action === 'workspaces-registry') {
        await runPixiWithProgress(
            `Pixi: Cleaning disassociated workspace registries for ${projectName}...`,
            ['clean', '--workspaces-registry'],
            projectPath,
            manager,
            `Pixi: Disassociated workspace registries cleaned for ${projectName}.`,
        );
        await manager.refreshAll();
        return;
    }

    if (choice.action === 'activation-cache') {
        await runPixiWithProgress(
            `Pixi: Cleaning activation cache for ${projectName}...`,
            ['clean', '--activation-cache'],
            projectPath,
            manager,
            `Pixi: Activation cache cleaned for ${projectName}.`,
        );
        return;
    }

    if (choice.action === 'build-cache') {
        await runPixiWithProgress(
            `Pixi: Cleaning build cache for ${projectName}...`,
            ['clean', '--build'],
            projectPath,
            manager,
            `Pixi: Build cache cleaned for ${projectName}.`,
        );
        return;
    }

    if (choice.action === 'environment') {
        const targetEnvName = await pickProjectEnvironmentName(manager, projectPath, {
            title: `Pixi: Clean Specific Environment (${projectName})`,
            placeHolder: 'Select an installed environment to clean from disk',
            filter: (e) => e.pixiStatus === 'installed',
            emptyMessage: `No installed environments found to clean in ${projectName}.`,
        });
        if (!targetEnvName) {
            return;
        }

        const confirmed = await window.showWarningMessage(
            `Clean the installed '${targetEnvName}' environment on disk for ${projectName}?`,
            'Clean Environment',
        );
        if (confirmed !== 'Clean Environment') {
            return;
        }

        await runPixiWithProgress(
            `Pixi: Cleaning environment '${targetEnvName}' for ${projectName}...`,
            ['clean', '-e', targetEnvName],
            projectPath,
            manager,
            `Pixi: Environment '${targetEnvName}' cleaned from disk.`,
        );
        return;
    }

    const confirmed = await window.showWarningMessage(
        `Are you sure you want to clean all installed Pixi environments in ${projectName}? (The .pixi directory will be removed)`,
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
}

async function handleLockCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to lock dependencies', targetItem);
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    await runPixiWithProgress(
        `Pixi: Solving and locking dependencies for ${projectName}...`,
        ['lock'],
        projectPath,
        manager,
        `Pixi: Lockfile (pixi.lock) updated successfully for ${projectName}.`,
    );
}

async function handleCheckLockfileCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to check lockfile', targetItem);
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    await window.withProgress(
        {
            location: ProgressLocation.Notification,
            title: `Pixi: Checking lockfile for ${projectName}...`,
            cancellable: false,
        },
        async () => {
            try {
                await runPixi(['lock', '--check'], { cwd: projectPath });
                window.showInformationMessage(`Pixi: Lockfile (pixi.lock) is up-to-date for ${projectName}.`);
            } catch {
                const action = await window.showWarningMessage(
                    `Pixi: Lockfile (pixi.lock) is out of sync with manifest for ${projectName}.`,
                    'Update Lockfile Now',
                );
                if (action === 'Update Lockfile Now') {
                    await handleLockCommand(manager, Uri.file(projectPath));
                }
            }
        },
    );
}

async function handleInstallCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    envName?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(
        manager,
        'Select Pixi project to install and sync environments',
        targetItem,
    );
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    const explicitEnv = extractEnvironmentName(targetItem, envName);

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
}

async function handleReinstallCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    envName?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to reinstall environments', targetItem);
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    let targetEnv = extractEnvironmentName(targetItem, envName);

    if (!targetEnv) {
        const choice = await window.showQuickPick(
            [
                {
                    label: '$(debug-restart) Reinstall All Environments',
                    description: `Reinstall all environments declared in ${projectName} (pixi reinstall --all)`,
                    action: 'all' as const,
                },
                {
                    label: '$(refresh) Reinstall Specific Environment...',
                    description: `Select a single environment to reinstall in ${projectName} (pixi reinstall -e <env>)`,
                    action: 'single' as const,
                },
                {
                    label: '$(package) Reinstall Specific Package...',
                    description: `Select a package to reinstall in ${projectName} (pixi reinstall <pkg> -e <env>)`,
                    action: 'package' as const,
                },
            ],
            {
                title: `Pixi: Reinstall (${projectName})`,
                placeHolder: 'Select reinstall scope',
            },
        );
        if (!choice) {
            return;
        }

        if (choice.action === 'package') {
            await commands.executeCommand('pixi.reinstallPackage', targetItem);
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
            return;
        }

        targetEnv = await pickInstallableEnvironment(
            manager,
            projectPath,
            'Pixi: Reinstall Environment',
            'Select environment to reinstall',
        );
        if (!targetEnv) {
            return;
        }
    }

    await runPixiWithProgress(
        `Pixi: Re-installing environment '${targetEnv}' for ${projectName}...`,
        ['reinstall', '-e', targetEnv],
        projectPath,
        manager,
        `Pixi: Environment '${targetEnv}' re-installed successfully for ${projectName}.`,
    );
}

async function handleOpenManifestCommand(manager: PixiProjectManager, targetItem?: unknown): Promise<void> {
    const ctx = extractCommandContext(targetItem);
    let manifestPath = ctx.manifestPath;

    if (!manifestPath) {
        const projectPath =
            ctx.projectPath || (await pickPixiProject(manager, 'Select Pixi project to open manifest', targetItem));
        if (!projectPath) {
            return;
        }
        manifestPath = manager.getManifestPath(projectPath);
    }

    if (!manifestPath || !(await openDocumentIfExists(manifestPath))) {
        window.showWarningMessage('Could not find manifest file for this project.');
    }
}

async function handleEnvironmentHubCommand(targetItem?: unknown): Promise<void> {
    const actions = [
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
            label: '$(trash) Remove Feature from Manifest...',
            description: 'Remove a feature from the project manifest (pixi workspace feature remove)',
            command: 'pixi.removeFeature',
        },
        {
            label: '$(cloud-download) Install / Sync Environments',
            description: 'Install or synchronize dependencies for a specific environment or entire project',
            command: 'pixi.install',
        },
        {
            label: '$(terminal) Open Terminal in Environment...',
            description: 'Open a dedicated terminal with the environment activated',
            command: 'pixi.openTerminal',
        },
        {
            label: '$(lock) Lock Dependencies',
            description: 'Solve dependencies and update pixi.lock without installing (pixi lock)',
            command: 'pixi.lock',
        },
        {
            label: '$(debug-restart) Reinstall Environments or Package...',
            description: 'Rebuild all environments, a specific environment, or reinstall a package (pixi reinstall)',
            command: 'pixi.reinstall',
        },
        {
            label: '$(export) Export Environment...',
            description: 'Export an environment as Conda environment.yml or explicit specification',
            command: 'pixi.exportEnvironment',
        },
        {
            label: '$(cloud-download) Import Dependencies from File...',
            description: 'Import Conda environment.yml or PyPI requirements.txt into environment or feature',
            command: 'pixi.import',
        },
        {
            label: '$(terminal) Run in Temporary Environment (Exec)...',
            description: 'Execute ad-hoc commands in a temporary environment (pixi exec)',
            command: 'pixi.exec',
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
}

async function handleFeatureHubCommand(targetItem?: unknown): Promise<void> {
    const actions = [
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
}

async function handleConfigureEnvironmentFeaturesCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    presetEnv?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(
        manager,
        'Select Pixi project to configure environment features for',
        targetItem,
    );
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    let envName = extractEnvironmentName(targetItem, presetEnv);
    if (!envName) {
        envName = await pickProjectEnvironmentName(manager, projectPath, {
            title: 'Pixi: Select Environment to Configure Features',
            placeHolder: 'Select environment',
            filter: (e) => e.pixiEnvName !== 'default',
            emptyMessage: `No custom environments found in ${projectName} to configure features.`,
        });
        if (!envName) {
            return;
        }
    }

    const [allFeatures, allEnvs] = await Promise.all([
        getWorkspaceFeatures(projectPath),
        getWorkspaceEnvironments(projectPath, manager),
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
        window.showWarningMessage('An environment must contain at least one feature (or the default feature).');
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
        ...(customFeatures.length > 0 ? customFeatures.flatMap((fn) => ['--feature', fn]) : ['--feature', 'default']),
        ...(includesDefault ? [] : ['--no-default-feature']),
        '--force',
    ];

    await runPixiWithProgress(
        `Pixi: Updating features for environment '${envName}' in ${projectName}...`,
        [args, ['install', '-e', envName]],
        projectPath,
        manager,
        `Pixi: Environment '${envName}' updated with features: ${selectedFeatureNames.join(', ')}.`,
    );
}

async function handleRemoveFeatureCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    presetFeature?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project to remove feature from', targetItem);
    if (!projectPath) {
        return;
    }

    const projectName = manager.getProjectName(projectPath);
    let featureName = extractFeatureName(targetItem, presetFeature);

    if (!featureName) {
        const pick = await pickPixiFeature(projectPath, {
            title: 'Pixi: Remove Feature',
            placeHolder: 'Select feature to remove from project manifest',
            emptyMessage: `No custom features found in ${projectName} to remove.`,
        });
        if (!pick) {
            return;
        }
        featureName = pick.name;
    }

    if (featureName === 'default') {
        window.showWarningMessage("The 'default' feature cannot be removed.");
        return;
    }

    const allEnvs = await getWorkspaceEnvironments(projectPath, manager);
    const referencingEnvs = getReferencingEnvs(allEnvs, featureName!);
    if (referencingEnvs.length > 0) {
        const choice = await window.showWarningMessage(
            `Feature '${featureName}' is referenced by environment(s): ${referencingEnvs.join(', ')}. Removing it will remove it from the project manifest. Do you want to proceed?`,
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
}

async function handleRevealFeatureCommand(
    manager: PixiProjectManager,
    targetItem?: unknown,
    presetFeature?: string,
): Promise<void> {
    const projectPath = await pickPixiProject(manager, 'Select Pixi project', targetItem);
    if (!projectPath) {
        return;
    }
    let featureName = extractFeatureName(targetItem, presetFeature);
    if (!featureName) {
        const pick = await pickPixiFeature(projectPath, {
            title: 'Select Feature to Reveal',
            includeDefault: true,
        });
        if (!pick) {
            return;
        }
        featureName = pick.name;
    }

    await revealDefinitionInManifest({
        manifestPath: manager.getManifestPath(projectPath),
        targetName: featureName,
        kind: 'feature',
    });
}

async function handleChangeGroupingCommand(): Promise<void> {
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
        await updateConfigurationValue(config, 'viewMode', selected.value);
    }
}

export function registerEnvironmentCommands(manager: PixiProjectManager): Disposable[] {
    return [
        commands.registerCommand('pixi.init', (targetItem?: unknown) => handleInitCommand(manager, targetItem)),
        commands.registerCommand('pixi.import', (targetItem?: unknown) => handleImportCommand(manager, targetItem)),
        commands.registerCommand('pixi.createFeature', (targetItem?: unknown) =>
            handleCreateFeatureCommand(manager, targetItem),
        ),
        commands.registerCommand('pixi.createEnvironment', (targetItem?: unknown) =>
            handleCreateEnvironmentCommand(manager, targetItem),
        ),
        commands.registerCommand('pixi.deleteEnvironment', (targetItem?: unknown, presetEnv?: string) =>
            handleDeleteEnvironmentCommand(manager, targetItem, presetEnv),
        ),
        commands.registerCommand('pixi.clean', (targetItem?: unknown) => handleCleanCommand(manager, targetItem)),
        commands.registerCommand('pixi.lock', (targetItem?: unknown) => handleLockCommand(manager, targetItem)),
        commands.registerCommand('pixi.checkLockfile', (targetItem?: unknown) =>
            handleCheckLockfileCommand(manager, targetItem),
        ),
        commands.registerCommand('pixi.installEnvironment', (targetItem?: unknown, presetEnv?: string) =>
            runSingleEnvironmentInstallCommand(manager, 'install', targetItem, presetEnv),
        ),
        commands.registerCommand('pixi.install', (targetItem?: unknown, envName?: string) =>
            handleInstallCommand(manager, targetItem, envName),
        ),
        commands.registerCommand('pixi.reinstallEnvironment', (targetItem?: unknown, presetEnv?: string) =>
            runSingleEnvironmentInstallCommand(manager, 'reinstall', targetItem, presetEnv),
        ),
        commands.registerCommand('pixi.reinstall', (targetItem?: unknown, envName?: string) =>
            handleReinstallCommand(manager, targetItem, envName),
        ),
        commands.registerCommand('pixi.openManifest', (targetItem?: unknown) =>
            handleOpenManifestCommand(manager, targetItem),
        ),
        commands.registerCommand('pixi.refreshProjects', () => manager.refresh(undefined)),
        commands.registerCommand('pixi.environment', (targetItem?: unknown) => handleEnvironmentHubCommand(targetItem)),
        commands.registerCommand('pixi.feature', (targetItem?: unknown) => handleFeatureHubCommand(targetItem)),
        commands.registerCommand('pixi.configureEnvironmentFeatures', (targetItem?: unknown, presetEnv?: string) =>
            handleConfigureEnvironmentFeaturesCommand(manager, targetItem, presetEnv),
        ),
        commands.registerCommand('pixi.removeFeature', (targetItem?: unknown, presetFeature?: string) =>
            handleRemoveFeatureCommand(manager, targetItem, presetFeature),
        ),
        commands.registerCommand('pixi.feature.revealInManifest', (targetItem?: unknown, presetFeature?: string) =>
            handleRevealFeatureCommand(manager, targetItem, presetFeature),
        ),
        commands.registerCommand('pixi.environments.changeGrouping', () => handleChangeGroupingCommand()),
    ];
}
