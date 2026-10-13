import * as path from 'path';
import { commands, Disposable, InputBoxValidationSeverity, QuickPickItem, Uri, window, workspace } from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { revealDefinitionInManifest } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import { DEFAULT_TASK_PREFIX_SEPARATORS, PixiTask, PixiTaskProvider } from '../../providers/taskProvider';
import { getWorkspaceFeatures, pickPixiProject, updateConfigurationValue } from './common';

function extractTask(targetItem?: unknown): PixiTask | undefined {
    if (!targetItem || typeof targetItem !== 'object') {
        return undefined;
    }
    const item = targetItem as { task?: PixiTask; args?: string[] };
    if (item.task) {
        return item.args ? { ...item.task, args: item.args } : item.task;
    }
    return undefined;
}

export function registerTaskCommands(manager: PixiProjectManager, taskProvider: PixiTaskProvider): Disposable[] {
    return [
        // Pixi: Run Task
        commands.registerCommand('pixi.runTask', async (targetItem?: unknown, extraArgs?: string[]) => {
            const targetTask = extractTask(targetItem);
            if (targetTask) {
                return taskProvider.executePixiTask(targetTask, undefined, extraArgs);
            }
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to run task in', targetItem);
            if (!projectPath) {
                return;
            }
            const selected = await taskProvider.pickTask({
                title: 'Pixi: Run Task',
                placeHolder: 'Select a Pixi task to run',
                targetProjectPath: projectPath,
            });
            if (selected) {
                await taskProvider.executePixiTask(selected, undefined, extraArgs);
            }
        }),

        // Pixi: Run Task in Environment
        commands.registerCommand('pixi.runTaskInEnvironment', async (targetItem?: unknown) => {
            const targetTask = extractTask(targetItem);
            if (targetTask) {
                return taskProvider.promptAndRunTaskInEnvironment(targetTask);
            }
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to run task in', targetItem);
            if (!projectPath) {
                return;
            }
            return taskProvider.promptAndRunTaskInEnvironment(undefined, projectPath);
        }),

        // Pixi: Refresh Tasks
        commands.registerCommand('pixi.tasks.refresh', () => {
            taskProvider.refresh();
        }),

        // Pixi: Change Grouping
        commands.registerCommand('pixi.tasks.changeGrouping', async () => {
            const config = workspace.getConfiguration('pixi.tasks');
            const current = config.get<string>('groupBy', 'prefix');

            interface GroupByQuickPickItem extends QuickPickItem {
                value: 'prefix' | 'environment' | 'none';
            }

            const items: GroupByQuickPickItem[] = [
                {
                    label: '$(symbol-namespace) Group by Prefix',
                    description: 'Group tasks by name prefix (e.g. data-*, test-*, gui-*)',
                    detail: current === 'prefix' ? '(Currently active)' : undefined,
                    value: 'prefix',
                },
                {
                    label: '$(layers) Group by Environment',
                    description: 'Group tasks by default environment (e.g. dev, test, docs)',
                    detail: current === 'environment' ? '(Currently active)' : undefined,
                    value: 'environment',
                },
                {
                    label: '$(list-flat) Flat List',
                    description: 'Display all tasks in a flat list without grouping',
                    detail: current === 'none' ? '(Currently active)' : undefined,
                    value: 'none',
                },
            ];

            const selected = await window.showQuickPick(items, {
                title: 'Pixi Tasks: Change Grouping',
                placeHolder: 'Select how tasks should be organized in the Tasks view',
            });

            if (selected) {
                await updateConfigurationValue(config, 'groupBy', selected.value);
            }
        }),

        // Pixi: Reveal Task in Manifest
        commands.registerCommand('pixi.tasks.revealInManifest', async (targetItem?: unknown) => {
            let task = extractTask(targetItem);

            if (!task) {
                const projectPath = await pickPixiProject(manager, 'Select Pixi project', targetItem);
                if (!projectPath) {
                    return;
                }
                task = await taskProvider.pickTask({
                    title: 'Select Task to Reveal in Manifest',
                    placeHolder: 'Select a task to jump to its definition in manifest',
                    targetProjectPath: projectPath,
                });
                if (!task) {
                    return;
                }
            }

            await revealDefinitionInManifest({
                manifestPath: manager.getManifestPath(task.projectPath),
                targetName: task.name,
                kind: 'task',
            });
        }),

        // Pixi: Add Task...
        commands.registerCommand('pixi.tasks.addTask', async (targetItem?: unknown) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add task to', targetItem);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const existingTasks = await taskProvider.getTasksForProject(projectPath);

            // Detect if invoked from a task group (e.g. prefix group or environment group)
            let defaultTaskName: string | undefined;
            let initialEnv: string | undefined;
            if (targetItem && typeof targetItem === 'object') {
                const item = targetItem as {
                    groupType?: 'prefix' | 'environment';
                    groupName?: string;
                    tasks?: Array<{ name: string }>;
                };
                if (item.groupType === 'prefix' && item.groupName) {
                    const separators = workspace
                        .getConfiguration('pixi.tasks', Uri.file(projectPath))
                        .get<string[]>('prefixSeparators', DEFAULT_TASK_PREFIX_SEPARATORS);
                    const sortedSeps = separators.filter(Boolean).sort((a, b) => b.length - a.length);
                    const sampleName = item.tasks?.[0]?.name;
                    const matchedSep = sampleName
                        ? sortedSeps.find((s) => sampleName.includes(`${item.groupName}${s}`))
                        : undefined;
                    if (sampleName && matchedSep) {
                        const token = `${item.groupName}${matchedSep}`;
                        defaultTaskName = sampleName.slice(0, sampleName.indexOf(token) + token.length);
                    } else {
                        defaultTaskName = `${item.groupName}${separators[0] || '-'}`;
                    }
                } else if (item.groupType === 'environment' && item.groupName) {
                    initialEnv = item.groupName;
                }
            }

            // Step 1: Prompt for task name
            const taskName = await window.showInputBox({
                title: `Pixi: Add Task (1/3) - [${projectName}]`,
                prompt: 'Enter task name (e.g. test, build, serve, lint)',
                value: defaultTaskName,
                valueSelection: defaultTaskName ? [defaultTaskName.length, defaultTaskName.length] : undefined,
                placeHolder: 'e.g. test, serve, build',
                validateInput: (value) => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                        return 'Task name cannot be empty';
                    }
                    if (/\s/.test(trimmed)) {
                        return 'Task name cannot contain spaces';
                    }
                    const lower = trimmed.toLowerCase();
                    const conflictTask = existingTasks.find((t) => t.name.toLowerCase() === lower);
                    if (conflictTask) {
                        const conflictEnv = conflictTask.default_environment || 'default';
                        if (initialEnv && conflictEnv === initialEnv) {
                            return `A task named '${trimmed}' already exists in environment '${initialEnv}'`;
                        }
                        return {
                            message: `A task named '${trimmed}' already exists in '${conflictEnv}'. Make sure to select a different environment in Step 3.`,
                            severity: InputBoxValidationSeverity.Warning,
                        };
                    }
                    return null;
                },
            });
            if (!taskName) {
                return;
            }

            // Step 2: Prompt for command
            const taskCmd = await window.showInputBox({
                title: `Pixi: Add Task (2/3) - Command for '${taskName}'`,
                prompt: `Enter command line to execute when running '${taskName}'`,
                placeHolder: 'e.g. pytest -v, uvicorn app:main --reload, cmake --build .',
                validateInput: (value) => {
                    if (!value.trim()) {
                        return 'Command cannot be empty';
                    }
                    return null;
                },
            });
            if (!taskCmd) {
                return;
            }

            // Step 3: Target Execution Scope (Standalone vs Default Environment vs Feature)
            let taskScope: { kind: 'standalone' | 'default-env' | 'feature'; name?: string } = { kind: 'standalone' };
            const envs = manager.getEnvironmentsForProject(projectPath);
            const namedEnvs = envs.filter((e) => e.pixiEnvName !== 'default');
            const features = (await getWorkspaceFeatures(projectPath)).filter((f) => f.name !== 'default');

            if (namedEnvs.length > 0 || features.length > 0) {
                interface TaskScopeQuickPickItem extends QuickPickItem {
                    scope: { kind: 'standalone' | 'default-env' | 'feature'; name?: string };
                }

                const hasInitialEnv = Boolean(initialEnv && initialEnv !== 'default');
                const standaloneItem: TaskScopeQuickPickItem = {
                    label: `$(globe) Standalone Task${hasInitialEnv ? '' : ' (Recommended)'}`,
                    description: 'Global task in [tasks], runnable in any environment',
                    scope: { kind: 'standalone' },
                };
                const makeEnvItem = (envName: string, recommended = false): TaskScopeQuickPickItem => ({
                    label: `$(server-environment) Default Environment: ${envName}${recommended ? ' (Recommended)' : ''}`,
                    description: `Task runs in '${envName}' by default (--default-environment)`,
                    scope: { kind: 'default-env', name: envName },
                });

                const scopeItems: TaskScopeQuickPickItem[] = hasInitialEnv
                    ? [
                          makeEnvItem(initialEnv!, true),
                          standaloneItem,
                          ...namedEnvs
                              .filter((e) => e.pixiEnvName !== initialEnv)
                              .map((e) => makeEnvItem(e.pixiEnvName)),
                      ]
                    : [standaloneItem, ...namedEnvs.map((e) => makeEnvItem(e.pixiEnvName))];

                for (const f of features) {
                    scopeItems.push({
                        label: `$(symbol-namespace) Feature: ${f.name}`,
                        description: `Bundle task with feature '${f.name}' (--feature)`,
                        scope: { kind: 'feature' as const, name: f.name },
                    });
                }

                const pickedScope = await window.showQuickPick(scopeItems, {
                    title: `Pixi: Task Scope for '${taskName}'`,
                    placeHolder: 'Select execution scope (Press Enter for Standalone Global Task)',
                });

                if (!pickedScope) {
                    return;
                }
                taskScope = pickedScope.scope;
            }

            // Step 4: Optional Dependencies (--depends-on) if other tasks exist
            let selectedDependsOn: string[] = [];
            if (existingTasks.length > 0) {
                const availableDepTasks = existingTasks.filter((t) => t.name.toLowerCase() !== taskName.toLowerCase());
                if (availableDepTasks.length > 0) {
                    interface DepTaskQuickPickItem extends QuickPickItem {
                        taskName: string;
                    }
                    const depItems: DepTaskQuickPickItem[] = availableDepTasks.map((t) => ({
                        label: `$(play) ${t.name}`,
                        description: t.default_environment ? `[${t.default_environment}] ${t.cmd || ''}` : t.cmd,
                        taskName: t.name,
                    }));

                    const pickedDeps = await window.showQuickPick(depItems, {
                        title: `Pixi: Add Task (Optional) - Dependencies for '${taskName}'`,
                        placeHolder: 'Select tasks that must run before this task (Press Enter to skip)',
                        canPickMany: true,
                    });

                    if (pickedDeps === undefined) {
                        return;
                    }
                    selectedDependsOn = pickedDeps.map((d) => d.taskName);
                }
            }

            const args = ['task', 'add'];
            if (taskScope.kind === 'default-env' && taskScope.name) {
                args.push('--default-environment', taskScope.name);
            } else if (taskScope.kind === 'feature' && taskScope.name) {
                args.push('--feature', taskScope.name);
            }
            for (const dep of selectedDependsOn) {
                args.push('--depends-on', dep);
            }
            args.push(taskName, '--', taskCmd);

            const success = await runPixiWithProgress(
                `Pixi: Adding task '${taskName}' to ${projectName}...`,
                args,
                projectPath,
                manager,
                `Pixi: Task '${taskName}' added successfully to ${projectName}.`,
            );

            if (success) {
                await revealDefinitionInManifest({
                    manifestPath: manager.getManifestPath(projectPath),
                    targetName: taskName,
                    kind: 'task',
                });
            }
        }),

        // Pixi: Remove Task
        commands.registerCommand('pixi.tasks.removeTask', async (targetItem?: unknown) => {
            let targetTask = extractTask(targetItem);

            if (!targetTask) {
                const projectPath = await pickPixiProject(
                    manager,
                    'Select Pixi project to remove task from',
                    targetItem,
                );
                if (!projectPath) {
                    return;
                }
                targetTask = await taskProvider.pickTask({
                    title: 'Pixi: Remove Task',
                    placeHolder: 'Select a Pixi task to remove from manifest',
                    targetProjectPath: projectPath,
                });
                if (!targetTask) {
                    return;
                }
            }

            const projectPath = targetTask.projectPath;
            const projectName = path.basename(projectPath);

            const confirmation = await window.showWarningMessage(
                `Are you sure you want to remove task '${targetTask.name}' from ${projectName}?`,
                'Remove Task',
            );
            if (confirmation !== 'Remove Task') {
                return;
            }

            const args = ['task', 'remove'];
            if (targetTask.inline_environment) {
                args.push('--environment', targetTask.inline_environment);
            } else if (targetTask.feature) {
                args.push('--feature', targetTask.feature);
            }
            args.push(targetTask.name);

            await runPixiWithProgress(
                `Pixi: Removing task '${targetTask.name}' from ${projectName}...`,
                args,
                projectPath,
                manager,
                `Pixi: Task '${targetTask.name}' removed successfully from ${projectName}.`,
            );
        }),
    ];
}
