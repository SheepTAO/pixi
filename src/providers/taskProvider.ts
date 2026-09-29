import * as path from 'path';
import {
    commands,
    Disposable,
    Event,
    EventEmitter,
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

import { getPixi, runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { getEnvironmentStatusBadge } from '../core/environmentRules';
import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo } from '../core/types';

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
    inputs?: string[];
    outputs?: string[];
    clean_env?: boolean;
    projectPath: string;
}

export interface PickTaskOptions {
    title: string;
    placeHolder: string;
    targetProjectPath?: string;
    formatEnvTag?: (env?: string) => string;
}

interface TaskQuickPickItem extends QuickPickItem {
    pixiTask: PixiTask;
}

export class PixiTaskProvider implements TaskProvider, Disposable {
    private readonly disposables: Disposable[] = [];
    private taskCache = new Map<string, PixiTask[]>();
    private taskPromises = new Map<string, Promise<PixiTask[]>>();
    private readonly _onDidChangeTasks = new EventEmitter<void>();
    readonly onDidChangeTasks: Event<void> = this._onDidChangeTasks.event;

    constructor(
        private readonly projectManager: PixiProjectManager,
        public readonly log?: LogOutputChannel,
    ) {
        // Invalidate cache when manifest files change
        const watcher = workspace.createFileSystemWatcher('**/{pixi.toml,pyproject.toml}');
        watcher.onDidChange(() => this.refresh(), this, this.disposables);
        watcher.onDidCreate(() => this.refresh(), this, this.disposables);
        watcher.onDidDelete(() => this.refresh(), this, this.disposables);
        this.disposables.push(watcher);

        this.disposables.push(tasks.registerTaskProvider('pixi', this));
    }

    public refresh(projectPath?: string): void {
        if (projectPath) {
            const normalized = path.normalize(projectPath);
            this.taskCache.delete(normalized);
            this.taskPromises.delete(normalized);
            this.taskCache.delete(projectPath);
            this.taskPromises.delete(projectPath);
        } else {
            this.taskCache.clear();
            this.taskPromises.clear();
        }
        this._onDidChangeTasks.fire();
    }

    dispose() {
        this.taskCache.clear();
        this.taskPromises.clear();
        this._onDidChangeTasks.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    registerCommands(): Disposable {
        const d1 = commands.registerCommand('pixi.runTask', (arg?: any) => {
            const targetTask = arg?.task || (arg?.name && arg?.projectPath ? arg : undefined);
            if (targetTask) {
                return this.executePixiTask(targetTask);
            }
            const projectPath =
                typeof arg === 'string' ? arg : arg?.project?.projectPath || arg?.projectPath || undefined;
            return this.promptAndRunTask(projectPath);
        });
        const d2 = commands.registerCommand('pixi.runTaskInEnvironment', (arg?: any) => {
            const targetTask = arg?.task || (arg?.name && arg?.projectPath ? arg : undefined);
            const projectPath = !targetTask
                ? typeof arg === 'string'
                    ? arg
                    : arg?.project?.projectPath || arg?.projectPath || undefined
                : undefined;
            return this.promptAndRunTaskInEnvironment(targetTask, projectPath);
        });
        return Disposable.from(d1, d2);
    }

    async provideTasks(): Promise<Task[]> {
        const projectPaths = this.projectManager.getProjectPaths();
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
            def.project || this.projectManager.getProjectPaths()[0] || workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        const normalized = path.normalize(projectPath);
        if (this.taskCache.has(normalized)) {
            return this.taskCache.get(normalized)!;
        }
        if (this.taskPromises.has(normalized)) {
            return this.taskPromises.get(normalized)!;
        }

        const promise = (async () => {
            try {
                const stdout = await runPixi(['task', 'list', '--json'], { cwd: normalized });
                const tasks = this.parsePixiTasksJson(stdout, normalized);
                this.taskCache.set(normalized, tasks);
                return tasks;
            } catch (err) {
                traceVerbose(`Could not load tasks for ${normalized}:`, err);
                return [];
            } finally {
                this.taskPromises.delete(normalized);
            }
        })();

        this.taskPromises.set(normalized, promise);
        return promise;
    }

    private parsePixiTasksJson(jsonStr: string, projectPath: string): PixiTask[] {
        const taskMap = new Map<string, PixiTask>();
        try {
            const raw = safeJsonParse<any[]>(jsonStr, []);
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
                        if (!t || !t.name) {
                            continue;
                        }
                        const cmdStr =
                            typeof t.cmd === 'string' ? t.cmd : Array.isArray(t.cmd) ? t.cmd.join(' ') : undefined;
                        const dependsOn = Array.isArray(t.depends_on) ? t.depends_on : undefined;
                        const inputs = Array.isArray(t.inputs) && t.inputs.length > 0 ? t.inputs : undefined;
                        const outputs = Array.isArray(t.outputs) && t.outputs.length > 0 ? t.outputs : undefined;
                        const cleanEnv = typeof t.clean_env === 'boolean' ? t.clean_env : undefined;

                        const existing = taskMap.get(t.name);
                        if (existing) {
                            if (!existing.cmd && cmdStr) {
                                existing.cmd = cmdStr;
                            }
                            if (!existing.description && t.description) {
                                existing.description = t.description;
                            }
                            if (!existing.default_environment && t.default_environment) {
                                existing.default_environment = t.default_environment;
                            }
                            if (
                                (!existing.depends_on || existing.depends_on.length === 0) &&
                                dependsOn &&
                                dependsOn.length > 0
                            ) {
                                existing.depends_on = dependsOn;
                            }
                            if (!existing.inputs && inputs) {
                                existing.inputs = inputs;
                            }
                            if (!existing.outputs && outputs) {
                                existing.outputs = outputs;
                            }
                            if (existing.clean_env === undefined && cleanEnv !== undefined) {
                                existing.clean_env = cleanEnv;
                            }
                        } else {
                            taskMap.set(t.name, {
                                name: t.name,
                                cmd: cmdStr,
                                description: t.description || undefined,
                                default_environment: t.default_environment || undefined,
                                depends_on: dependsOn,
                                inputs,
                                outputs,
                                clean_env: cleanEnv,
                                projectPath,
                            });
                        }
                    }
                }
            }
        } catch (e) {
            traceError('Failed to parse pixi task list JSON:', e);
        }
        return Array.from(taskMap.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
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

    public async pickTask(options: PickTaskOptions): Promise<PixiTask | undefined> {
        let projectPaths = this.projectManager.getProjectPaths();
        if (options.targetProjectPath) {
            const normalized = path.normalize(options.targetProjectPath);
            projectPaths = projectPaths.filter((p) => path.normalize(p) === normalized);
        }
        if (projectPaths.length === 0) {
            window.showWarningMessage('No Pixi projects found in the workspace.');
            return undefined;
        }

        const allTasks: PixiTask[] = [];
        for (const p of projectPaths) {
            allTasks.push(...(await this.getTasksForProject(p)));
        }

        if (allTasks.length === 0) {
            window.showInformationMessage('No Pixi tasks found.');
            return undefined;
        }

        const isMultiProject = !options.targetProjectPath && this.projectManager.getProjectPaths().length > 1;
        const formatEnv = options.formatEnvTag || ((env?: string) => (env ? `[${env}]` : ''));

        const items: TaskQuickPickItem[] = allTasks.map((t) => {
            const envTag = formatEnv(t.default_environment);
            const projTag = isMultiProject ? `(${path.basename(t.projectPath)})` : '';
            let detail = t.description || t.cmd;
            if (!detail && t.depends_on && t.depends_on.length > 0) {
                detail = `depends: ${t.depends_on.map((d) => d.task_name).join(', ')}`;
            }
            return {
                label: t.name,
                description: [envTag, projTag].filter(Boolean).join(' '),
                detail,
                pixiTask: t,
            };
        });

        const selected = await window.showQuickPick(items, {
            title: options.title,
            placeHolder: options.placeHolder,
            matchOnDescription: true,
            matchOnDetail: true,
        });

        return selected?.pixiTask;
    }

    private async promptAndRunTask(targetProjectPath?: string) {
        const selected = await this.pickTask({
            title: 'Pixi: Run Task',
            placeHolder: 'Select a Pixi task to run',
            targetProjectPath,
        });

        if (selected) {
            await this.executePixiTask(selected);
        }
    }

    public async executePixiTask(pixiTask: PixiTask, targetEnvName?: string): Promise<void> {
        const envName = targetEnvName || pixiTask.default_environment;
        if (envName) {
            const envs = this.projectManager.getEnvironmentsForProject(pixiTask.projectPath);
            const env = envs.find((e) => e.pixiEnvName === envName);
            if (env?.pixiStatus === 'incompatible') {
                const reason = env.statusReason || 'The environment is incompatible with the platform.';
                window.showErrorMessage(`Cannot run task '${pixiTask.name}' in environment '${envName}': ${reason}`);
                return;
            }
            if (env?.pixiStatus === 'uninstalled') {
                const action = await window.showWarningMessage(
                    `Environment '${envName}' required by task '${pixiTask.name}' is not installed yet on disk. Would you like to install it now?`,
                    'Install Environment',
                );
                if (action === 'Install Environment') {
                    await commands.executeCommand('pixi.install', env.projectPath, envName);
                }
                return;
            }
        }

        const taskToRun: PixiTask = targetEnvName ? { ...pixiTask, default_environment: targetEnvName } : pixiTask;
        const vsTask = await this.createVsCodeTask(taskToRun);
        await tasks.executeTask(vsTask);
    }

    public async promptAndRunTaskInEnvironment(presetTask?: PixiTask, targetProjectPath?: string): Promise<void> {
        const selectedTask =
            presetTask ||
            (await this.pickTask({
                title: 'Pixi: Run Task in Environment',
                placeHolder: 'Step 1: Select a Pixi task to run in a specific environment',
                targetProjectPath,
                formatEnvTag: (env) => (env ? `[default: ${env}]` : ''),
            }));

        if (!selectedTask) {
            return;
        }

        const envs = this.projectManager.getEnvironmentsForProject(selectedTask.projectPath);
        interface TaskEnvItem extends QuickPickItem {
            envName: string;
            pixiEnv?: PixiEnvironmentInfo;
        }

        const envItems: TaskEnvItem[] =
            envs.length > 0
                ? envs.map((e) => {
                      const { icon, text } = getEnvironmentStatusBadge(e.pixiStatus);
                      return {
                          label: `${icon} ${e.pixiEnvName}`,
                          description: text,
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
            title: `Pixi: Run Task '${selectedTask.name}'`,
            placeHolder: `Select environment to run '${selectedTask.name}' in`,
        });

        if (!selectedEnvItem) {
            return;
        }

        await this.executePixiTask(selectedTask, selectedEnvItem.envName);
    }
}
