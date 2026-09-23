import * as path from 'path';
import {
    commands,
    Disposable,
    LogOutputChannel,
    QuickPickItem,
    ShellExecution,
    Task,
    TaskDefinition,
    TaskGroup,
    TaskProvider,
    tasks,
    TaskScope,
    Uri,
    window,
    workspace,
} from 'vscode';

import { traceError, traceVerbose } from '../common/logging';
import { getPixi, runPixi } from './cli';
import { getEnvironmentQuickPickInfo, isEnvironmentInvalid } from './discovery';
import { PixiEnvManager } from './envManager';
import { PixiEnvironment } from './types';

export interface PixiTaskDefinition extends TaskDefinition {
    type: 'pixi';
    task: string;
    environment?: string;
    project?: string;
}

export interface PixiTask {
    name: string;
    cmd?: string;
    description?: string;
    default_environment?: string;
    depends_on?: Array<{ task_name: string }>;
    projectPath: string;
}

interface TaskQuickPickItem extends QuickPickItem {
    pixiTask: PixiTask;
}

export class PixiTaskProvider implements TaskProvider, Disposable {
    private readonly disposables: Disposable[] = [];
    private taskCache = new Map<string, PixiTask[]>();

    constructor(
        private readonly envManager: PixiEnvManager,
        private readonly log: LogOutputChannel,
    ) {
        // Invalidate cache when manifest files change
        const watcher = workspace.createFileSystemWatcher('**/{pixi.toml,pyproject.toml}');
        watcher.onDidChange(() => this.taskCache.clear(), this, this.disposables);
        watcher.onDidCreate(() => this.taskCache.clear(), this, this.disposables);
        watcher.onDidDelete(() => this.taskCache.clear(), this, this.disposables);
        this.disposables.push(watcher);

        this.disposables.push(tasks.registerTaskProvider('pixi', this));
    }

    dispose() {
        this.taskCache.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    registerCommands(): Disposable {
        const d1 = commands.registerCommand('pixi-python.runTask', () => this.promptAndRunTask());
        const d2 = commands.registerCommand('pixi-python.runTaskInEnvironment', () =>
            this.promptAndRunTaskInEnvironment(),
        );
        return Disposable.from(d1, d2);
    }

    async provideTasks(): Promise<Task[]> {
        const projectPaths = this.envManager.getProjectPaths();
        if (projectPaths.length === 0) {
            return [];
        }

        const allTasks: Task[] = [];
        for (const projectPath of projectPaths) {
            const pixiTasks = await this.getTasksForProject(projectPath);
            for (const t of pixiTasks) {
                try {
                    allTasks.push(await this.createVsCodeTask(t));
                } catch (err) {
                    traceError(`Failed to create task for ${t.name}:`, err);
                }
            }
        }
        return allTasks;
    }

    async resolveTask(task: Task): Promise<Task | undefined> {
        const def = task.definition as PixiTaskDefinition;
        if (!def.task) {
            return undefined;
        }

        const projectPath =
            def.project || this.envManager.getProjectPaths()[0] || workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!projectPath) {
            return undefined;
        }

        const pixiTask: PixiTask = {
            name: def.task,
            default_environment: def.environment,
            projectPath,
        };
        return this.createVsCodeTask(pixiTask, def);
    }

    async getTasksForProject(projectPath: string): Promise<PixiTask[]> {
        if (this.taskCache.has(projectPath)) {
            return this.taskCache.get(projectPath)!;
        }

        try {
            const stdout = await runPixi(['task', 'list', '--json'], { cwd: projectPath });
            const tasks = this.parsePixiTasksJson(stdout, projectPath);
            this.taskCache.set(projectPath, tasks);
            return tasks;
        } catch (err) {
            traceVerbose(`Could not load tasks for ${projectPath}:`, err);
            return [];
        }
    }

    private parsePixiTasksJson(jsonStr: string, projectPath: string): PixiTask[] {
        const taskMap = new Map<string, PixiTask>();
        try {
            const raw = JSON.parse(jsonStr);
            if (Array.isArray(raw)) {
                for (const envObj of raw) {
                    const all = [...(envObj.tasks || [])];
                    if (Array.isArray(envObj.features)) {
                        for (const f of envObj.features) {
                            if (Array.isArray(f.tasks)) {
                                all.push(...f.tasks);
                            }
                        }
                    }
                    for (const t of all) {
                        if (t && t.name && !taskMap.has(t.name)) {
                            taskMap.set(t.name, {
                                name: t.name,
                                cmd: typeof t.cmd === 'string' ? t.cmd : undefined,
                                description: t.description || undefined,
                                default_environment: t.default_environment || undefined,
                                depends_on: t.depends_on,
                                projectPath,
                            });
                        }
                    }
                }
            }
        } catch (e) {
            traceError('Failed to parse pixi task list JSON:', e);
        }
        return Array.from(taskMap.values());
    }

    private async createVsCodeTask(t: PixiTask, customDef?: PixiTaskDefinition): Promise<Task> {
        const pixiBin = await getPixi();
        const def: PixiTaskDefinition = customDef || {
            type: 'pixi',
            task: t.name,
            environment: t.default_environment,
            project: t.projectPath,
        };

        const args = ['run'];
        if (def.environment) {
            args.push('-e', def.environment);
        }
        args.push(def.task);

        const scope = workspace.getWorkspaceFolder(Uri.file(t.projectPath)) || TaskScope.Workspace;
        const task = new Task(def, scope, t.name, 'pixi', new ShellExecution(pixiBin, args, { cwd: t.projectPath }));

        task.detail = t.description || t.cmd;

        const lower = t.name.toLowerCase();
        if (lower.includes('test')) {
            task.group = TaskGroup.Test;
        } else if (lower.includes('build') || lower.includes('compile')) {
            task.group = TaskGroup.Build;
        }

        return task;
    }

    private async promptAndRunTask() {
        const projectPaths = this.envManager.getProjectPaths();
        if (projectPaths.length === 0) {
            window.showWarningMessage('No Pixi projects found in the workspace.');
            return;
        }

        const allTasks: PixiTask[] = [];
        for (const p of projectPaths) {
            allTasks.push(...(await this.getTasksForProject(p)));
        }

        if (allTasks.length === 0) {
            window.showInformationMessage('No Pixi tasks found.');
            return;
        }

        const isMultiProject = projectPaths.length > 1;
        const items: TaskQuickPickItem[] = allTasks.map((t) => {
            const envTag = t.default_environment ? `[${t.default_environment}]` : '';
            const projTag = isMultiProject ? `(${path.basename(t.projectPath)})` : '';
            return {
                label: t.name,
                description: [envTag, projTag].filter(Boolean).join(' '),
                detail: t.description || t.cmd,
                pixiTask: t,
            };
        });

        const selected = await window.showQuickPick(items, {
            placeHolder: 'Select a Pixi task to run',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        if (selected) {
            const vsTask = await this.createVsCodeTask(selected.pixiTask);
            await tasks.executeTask(vsTask);
        }
    }

    private async promptAndRunTaskInEnvironment() {
        const projectPaths = this.envManager.getProjectPaths();
        if (projectPaths.length === 0) {
            window.showWarningMessage('No Pixi projects found in the workspace.');
            return;
        }

        const allTasks: PixiTask[] = [];
        for (const p of projectPaths) {
            allTasks.push(...(await this.getTasksForProject(p)));
        }

        if (allTasks.length === 0) {
            window.showInformationMessage('No Pixi tasks found.');
            return;
        }

        const selectedTask = await window.showQuickPick(
            allTasks.map((t) => ({
                label: t.name,
                description: t.default_environment ? `[default: ${t.default_environment}]` : '',
                detail: t.description || t.cmd,
                pixiTask: t,
            })),
            { placeHolder: 'Step 1: Select a Pixi task' },
        );

        if (!selectedTask) {
            return;
        }

        const envs = this.envManager.getEnvironmentsForProject(selectedTask.pixiTask.projectPath);
        interface TaskEnvItem extends QuickPickItem {
            envName: string;
            pixiEnv?: PixiEnvironment;
        }

        const envItems: TaskEnvItem[] =
            envs.length > 0
                ? envs.map((e) => {
                      const info = getEnvironmentQuickPickInfo(e);
                      return {
                          label: `${info.icon} ${e.pixiEnvName}`,
                          description: info.statusText ? `${e.displayName} ${info.statusText}` : e.displayName,
                          envName: e.pixiEnvName,
                          pixiEnv: e,
                      };
                  })
                : [
                      {
                          label: '$(globe) default',
                          description: 'Default environment',
                          envName: 'default',
                      },
                  ];

        const selectedEnvItem = await window.showQuickPick(envItems, {
            placeHolder: `Step 2: Select environment to run '${selectedTask.label}'`,
        });

        if (!selectedEnvItem) {
            return;
        }

        if (isEnvironmentInvalid(selectedEnvItem.pixiEnv)) {
            const reason =
                selectedEnvItem.pixiEnv?.statusReason ||
                selectedEnvItem.pixiEnv?.error ||
                'The environment is incompatible with the current platform or missing Python.';
            window.showErrorMessage(
                `Cannot run task in environment '${selectedEnvItem.pixiEnv?.displayName}': ${reason}`,
            );
            return;
        }

        const taskWithEnv: PixiTask = {
            ...selectedTask.pixiTask,
            default_environment: selectedEnvItem.envName,
        };

        const vsTask = await this.createVsCodeTask(taskWithEnv);
        await tasks.executeTask(vsTask);
    }
}
