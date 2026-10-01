import * as path from 'path';
import {
    commands,
    ConfigurationTarget,
    Disposable,
    InputBoxValidationSeverity,
    QuickPickItem,
    Uri,
    window,
    workspace,
} from 'vscode';

import { runPixiWithProgress } from '../../cli/workspaceCli';
import { revealDefinitionInManifest } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiTask, PixiTaskProvider } from '../../providers/taskProvider';
import { pickPixiProject, pickTargetEnvironment } from './common';

export interface TaskCommandArg {
    task?: PixiTask;
    name?: string;
    projectPath?: string;
    project?: { projectPath?: string; manifestPath?: string };
}

function extractTask(arg?: unknown): PixiTask | undefined {
    return (arg as TaskCommandArg | undefined)?.task;
}

export function registerTaskCommands(manager: PixiProjectManager, taskProvider: PixiTaskProvider): Disposable[] {
    return [
        // Pixi: Run Task
        commands.registerCommand('pixi.runTask', async (arg?: unknown) => {
            const targetTask = extractTask(arg);
            if (targetTask) {
                return taskProvider.executePixiTask(targetTask);
            }
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to run task in', arg);
            if (!projectPath) {
                return;
            }
            const selected = await taskProvider.pickTask({
                title: 'Pixi: Run Task',
                placeHolder: 'Select a Pixi task to run',
                targetProjectPath: projectPath,
            });
            if (selected) {
                await taskProvider.executePixiTask(selected);
            }
        }),

        // Pixi: Run Task in Environment
        commands.registerCommand('pixi.runTaskInEnvironment', async (arg?: unknown) => {
            const targetTask = extractTask(arg);
            const projectPath =
                targetTask?.projectPath || (await pickPixiProject(manager, 'Select Pixi project to run task in', arg));
            return taskProvider.promptAndRunTaskInEnvironment(targetTask, projectPath);
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
                const inspect = config.inspect<string>('groupBy');
                const target =
                    inspect?.workspaceFolderValue !== undefined
                        ? ConfigurationTarget.WorkspaceFolder
                        : inspect?.workspaceValue !== undefined
                          ? ConfigurationTarget.Workspace
                          : ConfigurationTarget.Global;
                await config.update('groupBy', selected.value, target);
            }
        }),

        // Pixi: Reveal Task in Manifest
        commands.registerCommand('pixi.tasks.revealInManifest', async (arg?: unknown) => {
            let task = extractTask(arg);

            if (!task) {
                const projectPath = await pickPixiProject(manager, 'Select Pixi project', arg);
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
        commands.registerCommand('pixi.tasks.addTask', async (arg?: unknown) => {
            const projectPath = await pickPixiProject(manager, 'Select Pixi project to add task to', arg);
            if (!projectPath) {
                return;
            }

            const projectName = path.basename(projectPath);
            const existingTasks = await taskProvider.getTasksForProject(projectPath);

            // Detect if invoked from a task group (e.g. prefix group or environment group)
            let defaultTaskName: string | undefined;
            let initialEnv: string | undefined;
            if (arg && typeof arg === 'object') {
                const item = arg as {
                    groupType?: 'prefix' | 'environment';
                    groupName?: string;
                };
                if (item.groupType === 'prefix' && item.groupName) {
                    const separators = workspace
                        .getConfiguration('pixi.tasks', Uri.file(projectPath))
                        .get<string[]>('prefixSeparators', ['-', '_']);
                    const sep = (separators && separators[0]) || '-';
                    defaultTaskName = `${item.groupName}${sep}`;
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

            // Step 3: Target Environment / Feature (if project has multiple environments)
            let targetEnv = initialEnv;
            if (!targetEnv) {
                const envs = manager.getEnvironmentsForProject(projectPath);
                if (envs.length > 1) {
                    const selectedEnv = await pickTargetEnvironment(
                        envs,
                        'add',
                        'Select target environment for this task (Press Enter for Default)',
                    );
                    if (selectedEnv === null) {
                        return;
                    }
                    targetEnv = selectedEnv;
                }
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
            if (targetEnv && targetEnv !== 'default') {
                args.push('--environment', targetEnv);
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
                taskProvider.refresh(projectPath);
                await revealDefinitionInManifest({
                    manifestPath: manager.getManifestPath(projectPath),
                    targetName: taskName,
                    kind: 'task',
                });
            }
        }),

        // Pixi: Remove Task
        commands.registerCommand('pixi.tasks.removeTask', async (arg?: unknown) => {
            let targetTask = extractTask(arg);

            if (!targetTask) {
                const projectPath = await pickPixiProject(manager, 'Select Pixi project to remove task from', arg);
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
                { modal: true },
                'Remove Task',
            );
            if (confirmation !== 'Remove Task') {
                return;
            }

            const args = ['task', 'remove'];
            if (targetTask.default_environment && targetTask.default_environment !== 'default') {
                args.push('--environment', targetTask.default_environment);
            }
            args.push(targetTask.name);

            const success = await runPixiWithProgress(
                `Pixi: Removing task '${targetTask.name}' from ${projectName}...`,
                args,
                projectPath,
                manager,
                `Pixi: Task '${targetTask.name}' removed successfully from ${projectName}.`,
            );

            if (success) {
                taskProvider.refresh(projectPath);
            }
        }),
    ];
}
