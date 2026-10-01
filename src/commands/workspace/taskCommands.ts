import * as fs from 'fs';
import { commands, ConfigurationTarget, Disposable, QuickPickItem, window, workspace } from 'vscode';

import { revealDefinitionInManifest } from '../../common/execUtils';
import { PixiProjectManager } from '../../core/projectManager';
import { PixiTask, PixiTaskProvider } from '../../providers/taskProvider';

export interface TaskCommandArg {
    task?: PixiTask;
    name?: string;
    projectPath?: string;
    project?: { projectPath?: string; manifestPath?: string };
}

export function registerTaskCommands(manager: PixiProjectManager, taskProvider: PixiTaskProvider): Disposable[] {
    return [
        // Pixi: Run Task
        commands.registerCommand('pixi.runTask', async (arg?: unknown) => {
            const item = arg as TaskCommandArg | undefined;
            const targetTask = item?.task || (item?.name && item?.projectPath ? (item as PixiTask) : undefined);
            if (targetTask) {
                return taskProvider.executePixiTask(targetTask);
            }
            const projectPath =
                typeof arg === 'string' ? arg : item?.project?.projectPath || item?.projectPath || undefined;
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
        commands.registerCommand('pixi.runTaskInEnvironment', (arg?: unknown) => {
            const item = arg as TaskCommandArg | undefined;
            const targetTask = item?.task || (item?.name && item?.projectPath ? (item as PixiTask) : undefined);
            const projectPath = !targetTask
                ? typeof arg === 'string'
                    ? arg
                    : item?.project?.projectPath || item?.projectPath || undefined
                : item?.project?.projectPath || item?.projectPath || targetTask.projectPath;
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
            const item = arg as TaskCommandArg | undefined;
            let task: PixiTask | undefined =
                item?.task || (item?.name && item?.projectPath ? (item as PixiTask) : undefined);

            if (!task) {
                const targetProjectPath = item?.project?.projectPath || item?.projectPath;
                task = await taskProvider.pickTask({
                    title: 'Select Task to Reveal in Manifest',
                    placeHolder: 'Select a task to jump to its definition in manifest',
                    targetProjectPath,
                });
                if (!task) {
                    return;
                }
            }

            const projectPath = task.projectPath;
            const manifestPath = item?.project?.manifestPath || manager.getManifestPath(projectPath);

            if (!manifestPath || !fs.existsSync(manifestPath)) {
                window.showWarningMessage('Could not find manifest file for this project.');
                return;
            }

            await revealDefinitionInManifest({
                manifestPath,
                targetName: task.name,
                kind: 'task',
            });
        }),
    ];
}
