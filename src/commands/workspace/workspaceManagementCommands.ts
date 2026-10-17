import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commands, Disposable, OutputChannel, QuickPickItem, ThemeIcon, window, workspace } from 'vscode';

import { getPixi, runPixi } from '../../cli/pixiCli';
import { runPixiWithProgress } from '../../cli/workspaceCli';
import { runWithProgressNotification, safeJsonParse } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import {
    extractEnvironmentName,
    getWorkspaceDependencies,
    pickPixiProject,
    pickProjectEnvironmentName,
} from './common';

let activationChannel: OutputChannel | undefined;

export function registerWorkspaceManagementCommands(manager: PixiProjectManager): Disposable[] {
    return [
        // Pixi: Bump Workspace Version...
        commands.registerCommand('pixi.bumpVersion', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to manage version for', targetItem);
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            let currentVersion: string | undefined;
            try {
                const stdout = await runPixi(['workspace', 'version', 'get'], { cwd: projectPath });
                const trimmed = stdout.trim();
                if (trimmed) {
                    currentVersion = trimmed;
                }
            } catch {
                // If not set, currentVersion remains undefined
            }

            interface VersionActionItem extends QuickPickItem {
                action: 'patch' | 'minor' | 'major' | 'set';
            }

            const currentLabel = currentVersion ? ` (Current: v${currentVersion})` : ' (No version set)';
            const items: VersionActionItem[] = [
                {
                    label: '$(arrow-up) Bump Patch Version',
                    description: currentVersion
                        ? `Increment patch: ${currentVersion} -> patch`
                        : 'Initialize / bump patch',
                    detail: 'Suitable for backwards-compatible bug fixes',
                    action: 'patch',
                },
                {
                    label: '$(arrow-up) Bump Minor Version',
                    description: currentVersion ? `Increment minor: ${currentVersion} -> minor` : 'Increment minor',
                    detail: 'Suitable for backwards-compatible new features',
                    action: 'minor',
                },
                {
                    label: '$(rocket) Bump Major Version',
                    description: currentVersion ? `Increment major: ${currentVersion} -> major` : 'Increment major',
                    detail: 'Suitable for incompatible API changes',
                    action: 'major',
                },
                {
                    label: '$(edit) Set Custom Version...',
                    description: 'Specify an explicit version string',
                    detail: 'e.g. 1.0.0-rc.1, 2026.1, 0.5.0',
                    action: 'set',
                },
            ];

            const picked = await window.showQuickPick(items, {
                title: `Pixi: Workspace Version - ${projectName}${currentLabel}`,
                placeHolder: 'Select version bump action or set custom version',
            });
            if (!picked) {
                return;
            }

            let commandArgs: string[] = ['workspace', 'version', picked.action];
            let targetVersionStr: string = picked.action;

            if (picked.action === 'set') {
                const input = await window.showInputBox({
                    title: `Pixi: Set Version for '${projectName}'`,
                    prompt: 'Enter version string (e.g. 1.0.0 or 0.1.0-alpha.1)',
                    value: currentVersion || '0.1.0',
                    validateInput: (val) => (!val.trim() ? 'Version string cannot be empty' : null),
                });
                if (!input) {
                    return;
                }
                const cleanVersion = input.trim();
                commandArgs = ['workspace', 'version', 'set', cleanVersion];
                targetVersionStr = cleanVersion;
            }

            await runPixiWithProgress(
                `Pixi: Updating version for '${projectName}'...`,
                commandArgs,
                projectPath,
                manager,
                `Pixi: Workspace version updated to '${targetVersionStr}' for '${projectName}'.`,
            );
        }),

        // Pixi: Export Environment (Conda YAML or Explicit Spec)...
        commands.registerCommand('pixi.exportEnvironment', async (targetItem?: unknown, envName?: string) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to export environment from',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);
            const targetEnv =
                extractEnvironmentName(targetItem, envName) ||
                (await pickProjectEnvironmentName(manager, projectPath, {
                    title: `Pixi: Select Environment to Export (${projectName})`,
                    placeHolder: 'Select environment to export',
                }));

            if (!targetEnv) {
                return;
            }

            interface ExportChoice extends QuickPickItem {
                format: 'yaml' | 'explicit';
            }

            const formatChoice = await window.showQuickPick<ExportChoice>(
                [
                    {
                        label: '$(file-code) Conda Environment YAML (environment.yaml)',
                        description: 'pixi workspace export conda-environment',
                        detail: 'Standard Conda environment file with dependencies and channels',
                        format: 'yaml',
                    },
                    {
                        label: '$(lock) Conda Explicit Specification (@EXPLICIT)',
                        description: 'pixi workspace export conda-explicit-spec',
                        detail: 'Fully locked package URLs and checksums for instant, solver-less deployment',
                        format: 'explicit',
                    },
                ],
                {
                    title: `Pixi: Export Environment - ${targetEnv} (${projectName})`,
                    placeHolder: 'Select environment export format',
                },
            );

            if (!formatChoice) {
                return;
            }

            if (formatChoice.format === 'yaml') {
                const args = ['workspace', 'export', 'conda-environment'];
                if (targetEnv !== 'default') {
                    args.push('-e', targetEnv);
                }

                let yamlContent = '';
                try {
                    yamlContent = await runPixi(args, { cwd: projectPath, includeStderr: false });
                } catch (err: unknown) {
                    window.showErrorMessage(
                        `Failed to export environment '${targetEnv}': ${err instanceof Error ? err.message : String(err)}`,
                    );
                    return;
                }

                const doc = await workspace.openTextDocument({
                    content: yamlContent,
                    language: 'yaml',
                });
                await window.showTextDocument(doc, { preview: true });
                window.showInformationMessage(
                    `Pixi: Exported environment '${targetEnv}' (${projectName}) as Conda YAML.`,
                );
            } else {
                const tempDir = path.join(os.tmpdir(), `pixi-export-${Date.now()}`);
                await fs.promises.mkdir(tempDir, { recursive: true });
                const args = ['workspace', 'export', 'conda-explicit-spec', tempDir];
                if (targetEnv !== 'default') {
                    args.push('-e', targetEnv);
                }

                try {
                    await runPixi(args, { cwd: projectPath, includeStderr: true });
                    const files = await fs.promises.readdir(tempDir);
                    const specFiles = files.filter((f) => f.endsWith('.txt') || f.includes('conda_spec'));
                    if (specFiles.length === 0) {
                        window.showWarningMessage('No explicit specification files were generated.');
                        return;
                    }

                    for (const file of specFiles) {
                        const fullPath = path.join(tempDir, file);
                        const content = await fs.promises.readFile(fullPath, 'utf8');
                        const doc = await workspace.openTextDocument({
                            content,
                            language: 'text',
                        });
                        await window.showTextDocument(doc, { preview: true });
                    }
                    window.showInformationMessage(
                        `Pixi: Exported explicit specification for '${targetEnv}' (${projectName}).`,
                    );
                } catch (err: unknown) {
                    window.showErrorMessage(
                        `Failed to export explicit specification: ${err instanceof Error ? err.message : String(err)}`,
                    );
                } finally {
                    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
                }
            }
        }),

        // Pixi: Set Workspace Description...
        commands.registerCommand('pixi.setDescription', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to manage description for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            let currentDesc: string | undefined;
            try {
                const stdout = await runPixi(['workspace', 'description', 'get'], { cwd: projectPath });
                const trimmed = stdout.trim();
                if (trimmed) {
                    currentDesc = trimmed;
                }
            } catch {
                // If not set, currentDesc remains undefined
            }

            const input = await window.showInputBox({
                title: `Pixi: Workspace Description - ${projectName}`,
                prompt: 'Enter workspace description',
                value: currentDesc || '',
                placeHolder: 'A modern data science workspace with Python and Conda tools',
            });
            if (input === undefined) {
                return;
            }

            const newDesc = input.trim();
            if (!newDesc) {
                if (currentDesc) {
                    const confirm = await window.showWarningMessage(
                        `Clear workspace description for '${projectName}'?`,
                        'Clear Description',
                    );
                    if (confirm === 'Clear Description') {
                        await runPixiWithProgress(
                            `Pixi: Clearing workspace description for '${projectName}'...`,
                            ['workspace', 'description', 'set', ''],
                            projectPath,
                            manager,
                            `Pixi: Workspace description cleared for '${projectName}'.`,
                        );
                    }
                } else {
                    window.showInformationMessage('Pixi: Description was empty, no changes made.');
                }
                return;
            }

            await runPixiWithProgress(
                `Pixi: Updating workspace description for '${projectName}'...`,
                ['workspace', 'description', 'set', newDesc],
                projectPath,
                manager,
                `Pixi: Workspace description updated for '${projectName}'.`,
            );
        }),

        // Pixi: Configure Requires-Pixi Version...
        commands.registerCommand('pixi.setRequiresPixi', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to manage requires-pixi for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            let currentReq: string | undefined;
            try {
                const stdout = await runPixi(['workspace', 'requires-pixi', 'get'], { cwd: projectPath });
                const trimmed = stdout.trim();
                if (trimmed) {
                    currentReq = trimmed;
                }
            } catch {
                // If not set, currentReq remains undefined
            }

            interface RequiresPixiActionItem extends QuickPickItem {
                action: 'set' | 'unset' | 'verify';
            }

            const currentLabel = currentReq ? ` (Current: ${currentReq})` : ' (Not set)';
            const items: RequiresPixiActionItem[] = [
                {
                    label: '$(edit) Set Minimum Pixi Requirement...',
                    description: currentReq ? `Current: ${currentReq}` : 'e.g. >=0.80.0, >=0.81.0',
                    detail: 'Specify the minimum required Pixi version for this workspace',
                    action: 'set',
                },
            ];

            if (currentReq) {
                items.push({
                    label: '$(trash) Remove Pixi Requirement (Unset)',
                    description: `Remove ${currentReq}`,
                    detail: 'Allow any compatible Pixi version to open and run this workspace',
                    action: 'unset',
                });
            }

            items.push({
                label: '$(check) Verify Pixi Requirement',
                description: currentReq ? `Check if installed Pixi satisfies ${currentReq}` : 'Verify requirement',
                detail: 'Ensure the running Pixi CLI meets the workspace requirement',
                action: 'verify',
            });

            const picked = await window.showQuickPick(items, {
                title: `Pixi: Workspace Pixi Requirement - ${projectName}${currentLabel}`,
                placeHolder: 'Select action for requires-pixi constraint',
            });
            if (!picked) {
                return;
            }

            if (picked.action === 'unset') {
                await runPixiWithProgress(
                    `Pixi: Removing requires-pixi for '${projectName}'...`,
                    ['workspace', 'requires-pixi', 'unset'],
                    projectPath,
                    manager,
                    `Pixi: Requires-pixi removed for '${projectName}'.`,
                );
            } else if (picked.action === 'verify') {
                try {
                    await runPixi(['workspace', 'requires-pixi', 'verify'], { cwd: projectPath });
                    window.showInformationMessage(
                        `Pixi: The current Pixi installation satisfies the requires-pixi constraint for '${projectName}'.`,
                    );
                } catch (err: unknown) {
                    window.showErrorMessage(
                        `Pixi: Verification failed for '${projectName}': ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            } else if (picked.action === 'set') {
                const input = await window.showInputBox({
                    title: `Pixi: Set Requires-Pixi for '${projectName}'`,
                    prompt: 'Enter Pixi version constraint (e.g. >=0.80.0, >=0.81.0, >=1.0.0)',
                    value: currentReq || '>=0.80.0',
                    validateInput: (val) => (!val.trim() ? 'Version constraint cannot be empty' : null),
                });
                if (!input) {
                    return;
                }
                const cleanReq = input.trim();
                await runPixiWithProgress(
                    `Pixi: Setting requires-pixi for '${projectName}'...`,
                    ['workspace', 'requires-pixi', 'set', cleanReq],
                    projectPath,
                    manager,
                    `Pixi: Requires-pixi set to '${cleanReq}' for '${projectName}'.`,
                );
            }
        }),

        // Pixi: Set Workspace Name...
        commands.registerCommand('pixi.setProjectName', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to rename', targetItem);
            if (!projectPath) {
                return;
            }

            const currentName = manager.getProjectName(projectPath);

            const input = await window.showInputBox({
                title: `Pixi: Workspace Name - ${currentName}`,
                prompt: 'Enter new workspace name',
                value: currentName,
                validateInput: (val) => (!val.trim() ? 'Workspace name cannot be empty' : null),
            });
            if (!input) {
                return;
            }

            const cleanName = input.trim();
            if (cleanName === currentName) {
                return;
            }

            await runPixiWithProgress(
                `Pixi: Renaming workspace to '${cleanName}'...`,
                ['workspace', 'name', 'set', cleanName],
                projectPath,
                manager,
                `Pixi: Workspace renamed to '${cleanName}'.`,
            );
        }),

        // Pixi: Manage Preview Flags...
        commands.registerCommand('pixi.managePreviewFlags', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to manage preview flags for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            let enabledFlags: string[] = [];
            try {
                const stdout = await runPixi(['workspace', 'preview', 'list'], { cwd: projectPath });
                enabledFlags = stdout
                    .split(/\r?\n/)
                    .map((l) => l.trim().replace(/^[-*]\s*/, ''))
                    .filter(Boolean);
            } catch {
                // If not set, empty
            }

            const availableFlags: Array<{ flag: string; label: string; detail: string }> = [
                {
                    flag: 'pixi-build',
                    label: 'pixi-build',
                    detail: 'Enable Pixi built-in package builder and build-dependencies support',
                },
            ];

            const pickItems = availableFlags.map((item) => ({
                label: enabledFlags.includes(item.flag) ? `$(check) ${item.label}` : item.label,
                description: enabledFlags.includes(item.flag) ? '(Enabled)' : '(Disabled)',
                detail: item.detail,
                picked: enabledFlags.includes(item.flag),
                flag: item.flag,
            }));

            const selected = await window.showQuickPick(pickItems, {
                title: `Pixi: Workspace Preview Flags - ${projectName}`,
                placeHolder: 'Select preview flags to enable (uncheck to disable)',
                canPickMany: true,
            });
            if (!selected) {
                return;
            }

            const selectedSet = new Set(selected.map((s) => s.flag));
            const toAdd = availableFlags
                .map((f) => f.flag)
                .filter((f) => selectedSet.has(f) && !enabledFlags.includes(f));
            const toRemove = availableFlags
                .map((f) => f.flag)
                .filter((f) => !selectedSet.has(f) && enabledFlags.includes(f));

            if (toAdd.length === 0 && toRemove.length === 0) {
                return;
            }

            const commandsList: string[][] = [];
            for (const f of toAdd) {
                commandsList.push(['workspace', 'preview', 'add', f]);
            }
            for (const f of toRemove) {
                commandsList.push(['workspace', 'preview', 'remove', f]);
            }

            await runPixiWithProgress(
                `Pixi: Updating preview flags for '${projectName}'...`,
                commandsList,
                projectPath,
                manager,
                `Pixi: Updated preview flags for '${projectName}'.`,
            );
        }),

        // Pixi: Manage Environment Activation...
        commands.registerCommand('pixi.manageActivation', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to manage activation for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            interface ActivationActionItem extends QuickPickItem {
                action: 'list' | 'setEnv' | 'removeEnv' | 'addScript' | 'removeScript';
            }

            const items: ActivationActionItem[] = [
                {
                    label: '$(list-unordered) View Activation Configuration',
                    description: 'pixi workspace activation list',
                    detail: 'Inspect configured activation scripts and environment variables',
                    action: 'list',
                },
                {
                    label: '$(add) Set Environment Variable...',
                    description: 'pixi workspace activation env set KEY=VALUE',
                    detail: 'Set or update an environment variable applied during environment activation',
                    action: 'setEnv',
                },
                {
                    label: '$(trash) Remove Environment Variable...',
                    description: 'pixi workspace activation env remove KEY',
                    detail: 'Delete an activation environment variable by name',
                    action: 'removeEnv',
                },
                {
                    label: '$(file-code) Add Activation Script...',
                    description: 'pixi workspace activation script add SCRIPT',
                    detail: 'Add a shell script executed when the environment activates',
                    action: 'addScript',
                },
                {
                    label: '$(trash) Remove Activation Script...',
                    description: 'pixi workspace activation script remove SCRIPT',
                    detail: 'Remove a shell script from the activation.scripts list',
                    action: 'removeScript',
                },
            ];

            const picked = await window.showQuickPick(items, {
                title: `Pixi: Workspace Activation - ${projectName}`,
                placeHolder: 'Select activation configuration action',
            });
            if (!picked) {
                return;
            }

            if (picked.action === 'list') {
                try {
                    const stdout = await runPixi(['workspace', 'activation', 'list'], { cwd: projectPath });
                    activationChannel = activationChannel ?? window.createOutputChannel('Pixi Activation');
                    activationChannel.clear();
                    activationChannel.appendLine(`=== Pixi Activation: ${projectName} ===\n`);
                    activationChannel.appendLine(
                        stdout.trim() || 'No activation scripts or environment variables found in manifest.',
                    );
                    activationChannel.show(true);
                } catch (err: unknown) {
                    window.showErrorMessage(
                        `Failed to list activation: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            } else if (picked.action === 'setEnv') {
                const input = await window.showInputBox({
                    title: `Pixi: Set Activation Env Var (${projectName})`,
                    prompt: 'Enter environment variable as KEY=VALUE',
                    placeHolder: 'e.g. CUDA_VISIBLE_DEVICES=0 or MY_VAR=value',
                    validateInput: (val) => (!val.includes('=') ? 'Format must be KEY=VALUE' : null),
                });
                if (!input) {
                    return;
                }
                await runPixiWithProgress(
                    `Pixi: Setting activation env var for '${projectName}'...`,
                    ['workspace', 'activation', 'env', 'set', input.trim()],
                    projectPath,
                    manager,
                    `Pixi: Activation env var set for '${projectName}'.`,
                );
            } else if (picked.action === 'removeEnv') {
                const key = await window.showInputBox({
                    title: `Pixi: Remove Activation Env Var (${projectName})`,
                    prompt: 'Enter variable name to remove',
                    placeHolder: 'e.g. CUDA_VISIBLE_DEVICES',
                    validateInput: (val) => (!val.trim() ? 'Variable name cannot be empty' : null),
                });
                if (!key) {
                    return;
                }
                await runPixiWithProgress(
                    `Pixi: Removing activation env var '${key.trim()}' for '${projectName}'...`,
                    ['workspace', 'activation', 'env', 'remove', key.trim()],
                    projectPath,
                    manager,
                    `Pixi: Activation env var '${key.trim()}' removed for '${projectName}'.`,
                );
            } else if (picked.action === 'addScript') {
                const script = await window.showInputBox({
                    title: `Pixi: Add Activation Script (${projectName})`,
                    prompt: 'Enter relative path to script file (e.g. activate.sh or scripts/setup.bat)',
                    placeHolder: 'activate.sh',
                    validateInput: (val) => (!val.trim() ? 'Script path cannot be empty' : null),
                });
                if (!script) {
                    return;
                }
                await runPixiWithProgress(
                    `Pixi: Adding activation script for '${projectName}'...`,
                    ['workspace', 'activation', 'script', 'add', script.trim()],
                    projectPath,
                    manager,
                    `Pixi: Activation script '${script.trim()}' added for '${projectName}'.`,
                );
            } else if (picked.action === 'removeScript') {
                const script = await window.showInputBox({
                    title: `Pixi: Remove Activation Script (${projectName})`,
                    prompt: 'Enter script path to remove from activation.scripts',
                    placeHolder: 'activate.sh',
                    validateInput: (val) => (!val.trim() ? 'Script path cannot be empty' : null),
                });
                if (!script) {
                    return;
                }
                await runPixiWithProgress(
                    `Pixi: Removing activation script for '${projectName}'...`,
                    ['workspace', 'activation', 'script', 'remove', script.trim()],
                    projectPath,
                    manager,
                    `Pixi: Activation script '${script.trim()}' removed for '${projectName}'.`,
                );
            }
        }),

        // Pixi: Run in Temporary Environment (Exec)...
        commands.registerCommand('pixi.exec', async (targetItem?: unknown) => {
            const projectPath =
                (await pickPixiProject(manager, 'Select working directory for temporary execution', targetItem)) ||
                workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            const input = await window.showInputBox({
                title: `Pixi: Run in Temporary Environment (${projectName})`,
                prompt: 'Enter command to execute in temporary environment (e.g. ruff check . or marimo edit)',
                placeHolder: 'ruff check .',
                validateInput: (val) => (!val.trim() ? 'Command cannot be empty' : null),
            });
            if (!input) {
                return;
            }

            const cleanCmd = input.trim();
            const pixiBin = await getPixi();
            const terminal = window.createTerminal({
                name: `Pixi Exec: ${cleanCmd.split(/\s+/)[0]}`,
                cwd: projectPath,
            });
            terminal.show();
            terminal.sendText(`"${pixiBin}" exec ${cleanCmd}`);
        }),

        // Pixi: Manage Workspace Dependencies ([workspace.dependencies])...
        commands.registerCommand('pixi.workspaceDependencies', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to manage workspace dependencies for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            let currentListOutput = '';
            try {
                currentListOutput = await runPixi(['workspace', 'dependencies', 'list'], { cwd: projectPath });
            } catch {
                // ignore
            }

            const action = await window.showQuickPick(
                [
                    {
                        label: '$(list-unordered) View Workspace Dependencies',
                        description: 'pixi workspace dependencies list',
                        detail: currentListOutput.trim() || 'List dependencies in [workspace.dependencies]',
                        action: 'list',
                    },
                    {
                        label: '$(add) Add Workspace Dependency...',
                        description: 'pixi workspace dependencies add <SPEC>',
                        detail: 'Add shared dependency to [workspace.dependencies] table',
                        action: 'add',
                    },
                    {
                        label: '$(trash) Remove Workspace Dependency...',
                        description: 'pixi workspace dependencies remove <PACKAGE>',
                        detail: 'Remove shared dependency from [workspace.dependencies]',
                        action: 'remove',
                    },
                ],
                {
                    title: `Pixi: Workspace Dependencies (${projectName})`,
                    placeHolder: 'Select action to manage [workspace.dependencies]',
                },
            );

            if (!action) {
                return;
            }

            if (action.action === 'list') {
                const lines = currentListOutput
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter(Boolean);
                if (lines.length === 0) {
                    window.showInformationMessage(`No workspace dependencies found in '${projectName}'.`);
                    return;
                }
                await window.showQuickPick(
                    lines.map((line) => ({
                        label: line,
                        iconPath: new ThemeIcon('package'),
                    })),
                    {
                        title: `Pixi: Workspace Dependencies (${projectName})`,
                        placeHolder: 'Dependencies defined in [workspace.dependencies]',
                    },
                );
                return;
            }

            if (action.action === 'add') {
                const spec = await window.showInputBox({
                    title: `Pixi: Add Workspace Dependency (${projectName})`,
                    prompt: 'Enter dependency name or MatchSpec (e.g. pytest>=8.0, ruff, or cmake)',
                    placeHolder: 'pytest>=8.0',
                    validateInput: (val) => (!val.trim() ? 'Dependency specification cannot be empty' : null),
                });
                if (!spec) {
                    return;
                }

                await runPixiWithProgress(
                    `Pixi: Adding workspace dependency '${spec.trim()}' to ${projectName}...`,
                    ['workspace', 'dependencies', 'add', spec.trim()],
                    projectPath,
                    manager,
                    `Pixi: Workspace dependency '${spec.trim()}' added to ${projectName}.`,
                );
                return;
            }

            if (action.action === 'remove') {
                const uniquePackages = await getWorkspaceDependencies(projectPath);

                let pkg: string | undefined;
                if (uniquePackages.length > 0) {
                    interface PkgPickItem extends QuickPickItem {
                        pkgName?: string;
                        isManual?: boolean;
                    }
                    const items: PkgPickItem[] = [
                        ...uniquePackages.map((p) => ({
                            label: `$(package) ${p}`,
                            description: 'Remove from [workspace.dependencies]',
                            pkgName: p,
                        })),
                        {
                            label: '$(edit) Enter package name manually...',
                            isManual: true,
                        },
                    ];
                    const picked = await window.showQuickPick(items, {
                        title: `Pixi: Remove Workspace Dependency (${projectName})`,
                        placeHolder: 'Select a workspace dependency to remove',
                    });
                    if (!picked) {
                        return;
                    }
                    if (picked.isManual) {
                        pkg = await window.showInputBox({
                            title: `Pixi: Remove Workspace Dependency (${projectName})`,
                            prompt: 'Enter package name to remove from [workspace.dependencies]',
                            placeHolder: 'e.g. pytest',
                            validateInput: (val) => (!val.trim() ? 'Package name cannot be empty' : null),
                        });
                    } else {
                        pkg = picked.pkgName;
                    }
                } else {
                    pkg = await window.showInputBox({
                        title: `Pixi: Remove Workspace Dependency (${projectName})`,
                        prompt: 'Enter package name to remove from [workspace.dependencies]',
                        placeHolder: 'e.g. pytest',
                        validateInput: (val) => (!val.trim() ? 'Package name cannot be empty' : null),
                    });
                }

                if (!pkg || !pkg.trim()) {
                    return;
                }

                await runPixiWithProgress(
                    `Pixi: Removing workspace dependency '${pkg.trim()}' from ${projectName}...`,
                    ['workspace', 'dependencies', 'remove', pkg.trim()],
                    projectPath,
                    manager,
                    `Pixi: Workspace dependency '${pkg.trim()}' removed from ${projectName}.`,
                );
            }
        }),

        // Pixi: Workspace ... (Unified Workspace Hub)
        commands.registerCommand('pixi.workspace', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to manage workspace for',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);

            interface WorkspaceActionItem extends QuickPickItem {
                command: string;
            }

            const items: WorkspaceActionItem[] = [
                {
                    label: '$(tag) Bump / Set Version ...',
                    description: 'Bump patch, minor, major, or set custom version in [workspace.version]',
                    command: 'pixi.bumpVersion',
                },
                {
                    label: '$(layers) Manage Workspace Dependencies ...',
                    description: 'Add, remove, or view shared dependencies in [workspace.dependencies]',
                    command: 'pixi.workspaceDependencies',
                },
                {
                    label: '$(edit) Rename Workspace ...',
                    description: 'Get or update workspace name via pixi workspace name',
                    command: 'pixi.setProjectName',
                },
                {
                    label: '$(note) Set Workspace Description ...',
                    description: 'Get or update workspace description via pixi workspace description',
                    command: 'pixi.setDescription',
                },
                {
                    label: '$(verified) Set Minimum Pixi Requirement ...',
                    description: 'Configure requires-pixi constraint via pixi workspace requires-pixi',
                    command: 'pixi.setRequiresPixi',
                },
                {
                    label: '$(beaker) Manage Workspace Preview Flags ...',
                    description: 'Inspect, enable, or disable workspace preview flags (e.g. pixi-build)',
                    command: 'pixi.managePreviewFlags',
                },
                {
                    label: '$(play) Manage Environment Activation ...',
                    description: 'Configure environment activation scripts and environment variables',
                    command: 'pixi.manageActivation',
                },
                {
                    label: '$(bookmark) Register in Machine Registry ...',
                    description: 'Register project path in machine-wide workspace registry',
                    command: 'pixi.workspace.register',
                },
                {
                    label: '$(archive) Unregister from Machine Registry ...',
                    description: 'Remove a workspace from machine-wide registry',
                    command: 'pixi.workspace.unregister',
                },
            ];

            const picked = await window.showQuickPick(items, {
                title: `Pixi: Workspace Management [${projectName}]`,
                placeHolder: 'Select a workspace configuration operation',
            });
            if (!picked) {
                return;
            }

            await commands.executeCommand(picked.command, targetItem || projectPath);
        }),

        // Pixi: Register Workspace in Machine Registry...
        commands.registerCommand('pixi.workspace.register', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(
                manager,
                'Select Pixi project to register machine-wide',
                targetItem,
            );
            if (!projectPath) {
                return;
            }

            const projectName = manager.getProjectName(projectPath);
            await runPixiWithProgress(
                `Pixi: Registering workspace '${projectName}' machine-wide...`,
                ['workspace', 'register', '--path', projectPath],
                projectPath,
                manager,
                `Pixi: Workspace '${projectName}' registered successfully in machine registry.`,
            );
        }),

        // Pixi: Unregister Workspace from Machine Registry...
        commands.registerCommand('pixi.workspace.unregister', async (_targetItem?: unknown) => {
            let registered: Record<string, string> = {};
            try {
                const regOut = await runPixi(['workspace', 'register', 'list', '--json']);
                registered = safeJsonParse<Record<string, string>>(regOut, {});
            } catch (err) {
                window.showErrorMessage(
                    `Failed to list registered workspaces: ${err instanceof Error ? err.message : String(err)}`,
                );
                return;
            }

            const entries = Object.entries(registered);
            if (entries.length === 0) {
                window.showInformationMessage('No workspaces currently registered on this machine.');
                return;
            }

            const picked = await window.showQuickPick(
                entries.map(([name, wsPath]) => ({
                    label: `$(archive) ${name}`,
                    description: wsPath,
                    workspaceName: name,
                })),
                {
                    title: 'Pixi: Unregister Workspace',
                    placeHolder: 'Select registered workspace to remove from machine registry',
                },
            );

            if (!picked) {
                return;
            }

            await runWithProgressNotification(
                `Pixi: Unregistering workspace '${picked.workspaceName}'...`,
                async (token) => {
                    const out = await runPixi(
                        ['workspace', 'register', 'remove', picked.workspaceName],
                        { includeStderr: true },
                        token,
                    );
                    await manager.refreshAll();
                    return out;
                },
                `Pixi: Workspace '${picked.workspaceName}' removed from registry.`,
            );
        }),
    ];
}
