import * as path from 'path';
import {
    Disposable,
    Event,
    EventEmitter,
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
import { resolveReadyEnvironment } from '../commands/workspace/common';
import { quoteStringIfNecessary, safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { ensureEnvironmentReady } from '../core/environmentRules';
import { getProjectKey } from '../core/projectDiscovery';
import { PixiProjectManager } from '../core/projectManager';

export const DEFAULT_TASK_PREFIX_SEPARATORS = ['-', '_', ':', '::'];

export interface PixiTaskDefinition extends TaskDefinition {
    type: 'pixi';
    task: string;
    environment?: string;
    project?: string;
    args?: string[];
    rawArgs?: string;
}

export interface PixiTask {
    name: string;
    cmd?: string;
    description?: string;
    default_environment?: string;
    feature?: string;
    inline_environment?: string;
    depends_on?: Array<{ task_name: string }>;
    inputs?: string[];
    outputs?: string[];
    clean_env?: boolean;
    projectPath: string;
    args?: string[];
    rawArgs?: string;
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

interface RawPixiTask {
    name?: string;
    cmd?: string | string[];
    description?: string;
    default_environment?: string;
    depends_on?: { task_name: string }[];
    inputs?: string[];
    outputs?: string[];
    clean_env?: boolean;
}

interface RawPixiTaskEnvironment {
    environment?: string;
    tasks?: RawPixiTask[];
    features?: { name?: string; tasks?: RawPixiTask[] }[];
}

export class PixiTaskProvider implements TaskProvider, Disposable {
    private readonly disposables: Disposable[] = [];
    private readonly taskCache = new Map<string, Promise<PixiTask[]>>();
    private readonly _onDidChangeTasks = new EventEmitter<void>();
    readonly onDidChangeTasks: Event<void> = this._onDidChangeTasks.event;

    constructor(private readonly projectManager: PixiProjectManager) {
        this.disposables.push(
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
            tasks.registerTaskProvider('pixi', this),
        );
    }

    public refresh(projectPath?: string): void {
        if (projectPath) {
            this.taskCache.delete(getProjectKey(projectPath));
        } else {
            this.taskCache.clear();
        }
        this._onDidChangeTasks.fire();
    }

    public dispose(): void {
        this.taskCache.clear();
        this._onDidChangeTasks.dispose();
        Disposable.from(...this.disposables).dispose();
    }

    async provideTasks(): Promise<Task[]> {
        const projectPaths = this.projectManager.getProjectPaths();
        if (projectPaths.length === 0) {
            return [];
        }

        const projectTasksList = await Promise.all(projectPaths.map((p) => this.getTasksForProject(p)));

        const allTasks: Task[] = [];
        for (const t of projectTasksList.flat()) {
            try {
                allTasks.push(await this.createVsCodeTask(t));
            } catch (err) {
                traceError(`Failed to create task for ${t.name}:`, err);
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
            args: def.args,
            rawArgs: def.rawArgs,
        };
        return this.createVsCodeTask(pixiTask, def);
    }

    async getTasksForProject(projectPath: string): Promise<PixiTask[]> {
        const projectKey = getProjectKey(projectPath);
        let promise = this.taskCache.get(projectKey);
        if (!promise) {
            const normalized = path.normalize(projectPath);
            promise = runPixi(['task', 'list', '--json'], { cwd: normalized })
                .then((stdout) => this.parsePixiTasksJson(stdout, normalized))
                .catch((err) => {
                    this.taskCache.delete(projectKey);
                    traceVerbose(`Could not load tasks for ${normalized}:`, err);
                    return [];
                });
            this.taskCache.set(projectKey, promise);
        }
        return promise;
    }

    private parsePixiTasksJson(jsonStr: string, projectPath: string): PixiTask[] {
        const raw = safeJsonParse<RawPixiTaskEnvironment[]>(jsonStr, []);
        if (!Array.isArray(raw)) {
            return [];
        }

        const taskMap = new Map<string, PixiTask>();
        const registerTask = (
            t: RawPixiTask,
            scope: { fallbackEnv?: string; feature?: string; inlineEnv?: string },
        ) => {
            if (!t || !t.name) {
                return;
            }
            const existing = taskMap.get(t.name);
            if (!existing) {
                taskMap.set(t.name, {
                    name: t.name,
                    cmd: typeof t.cmd === 'string' ? t.cmd : Array.isArray(t.cmd) ? t.cmd.join(' ') : undefined,
                    description: t.description || undefined,
                    default_environment: t.default_environment || scope.fallbackEnv,
                    feature: scope.feature,
                    inline_environment: scope.inlineEnv,
                    depends_on: Array.isArray(t.depends_on) && t.depends_on.length > 0 ? t.depends_on : undefined,
                    inputs: Array.isArray(t.inputs) && t.inputs.length > 0 ? t.inputs : undefined,
                    outputs: Array.isArray(t.outputs) && t.outputs.length > 0 ? t.outputs : undefined,
                    clean_env: typeof t.clean_env === 'boolean' ? t.clean_env : undefined,
                    projectPath,
                });
            } else {
                existing.default_environment ||= scope.fallbackEnv;
                existing.feature ||= scope.feature;
                existing.inline_environment ||= scope.inlineEnv;
            }
        };

        for (const envObj of raw) {
            const envName = envObj.environment && envObj.environment !== 'default' ? envObj.environment : undefined;

            // 1. Inline environment tasks ([environments.<env>.tasks])
            for (const t of envObj.tasks ?? []) {
                registerTask(t, { fallbackEnv: envName, inlineEnv: envObj.environment });
            }

            // 2. Feature tasks ([tasks] under default feature, or [feature.<name>.tasks])
            for (const f of envObj.features ?? []) {
                const featureName = f.name && f.name !== 'default' ? f.name : undefined;
                const fallbackEnv = featureName ? envName || featureName : undefined;
                for (const t of f.tasks ?? []) {
                    registerTask(t, { fallbackEnv, feature: featureName });
                }
            }
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
            args: t.args,
            rawArgs: t.rawArgs,
        };

        const parts = [quoteStringIfNecessary(pixiBin), 'run'];
        if (def.environment) {
            parts.push('-e', quoteStringIfNecessary(def.environment));
        }
        parts.push(quoteStringIfNecessary(def.task));

        let commandLine = parts.join(' ');
        if (def.rawArgs && def.rawArgs.trim()) {
            commandLine += ` ${def.rawArgs.trim()}`;
        } else if (def.args && def.args.length > 0) {
            commandLine += ` ${def.args.map(quoteStringIfNecessary).join(' ')}`;
        }

        const scope = workspace.getWorkspaceFolder(Uri.file(t.projectPath)) || TaskScope.Workspace;
        const task = new Task(def, scope, t.name, 'pixi', new ShellExecution(commandLine, { cwd: t.projectPath }));

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
            projectPaths = projectPaths.filter((p) => p === normalized);
        }
        if (projectPaths.length === 0) {
            window.showWarningMessage('No Pixi projects found in the workspace.');
            return undefined;
        }

        const allTasks = (await Promise.all(projectPaths.map((p) => this.getTasksForProject(p)))).flat();

        if (allTasks.length === 0) {
            window.showInformationMessage('No Pixi tasks found.');
            return undefined;
        }

        const isMultiProject = projectPaths.length > 1;
        const formatEnv = options.formatEnvTag || ((env?: string) => (env ? `[${env}]` : ''));

        const items: TaskQuickPickItem[] = allTasks.map((t) => {
            const envTag = formatEnv(t.default_environment);
            const projTag = isMultiProject ? `(${path.basename(t.projectPath)})` : '';
            const detail = formatTaskDetail(t);
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

    public async executePixiTask(
        pixiTask: PixiTask,
        targetEnvName?: string,
        extraArgsOrRawArgs?: string[] | string,
    ): Promise<void> {
        const envName = targetEnvName || pixiTask.default_environment;
        if (envName) {
            const envs = this.projectManager.getEnvironmentsForProject(pixiTask.projectPath);
            const env = envs.find((e) => e.pixiEnvName === envName);
            if (
                env &&
                !(await ensureEnvironmentReady(env, {
                    action: `run task '${pixiTask.name}' in environment`,
                    customInstallPrompt: `Environment '${envName}' required by task '${pixiTask.name}' is not installed yet on disk. Would you like to install it now?`,
                }))
            ) {
                return;
            }
        }

        let rawArgs = pixiTask.rawArgs;
        let args = pixiTask.args;

        if (typeof extraArgsOrRawArgs === 'string') {
            const trimmed = extraArgsOrRawArgs.trim();
            if (trimmed) {
                rawArgs = rawArgs ? `${rawArgs} ${trimmed}` : trimmed;
            }
        } else if (Array.isArray(extraArgsOrRawArgs) && extraArgsOrRawArgs.length > 0) {
            args = args ? [...args, ...extraArgsOrRawArgs] : extraArgsOrRawArgs;
        }

        const taskToRun: PixiTask = {
            ...pixiTask,
            ...(targetEnvName ? { default_environment: targetEnvName } : {}),
            ...(rawArgs !== undefined ? { rawArgs } : {}),
            ...(args !== undefined ? { args } : {}),
        };
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

        const env = await resolveReadyEnvironment(this.projectManager, selectedTask.projectPath, {
            title: `Pixi: Run Task '${selectedTask.name}'`,
            placeHolder: `Select environment to run '${selectedTask.name}' in`,
            autoSelectSingle: false,
            action: `run task '${selectedTask.name}' in environment`,
        });

        if (!env) {
            return;
        }

        const inputArgs = await promptForTaskArgs(selectedTask.name, env.pixiEnvName);
        if (inputArgs === undefined) {
            return;
        }

        await this.executePixiTask(selectedTask, env.pixiEnvName, inputArgs.trim() || undefined);
    }
}

export function formatTaskDetail(task: PixiTask): string | undefined {
    if (task.description || task.cmd) {
        return task.description || task.cmd;
    }
    if (task.depends_on && task.depends_on.length > 0) {
        return `depends: ${task.depends_on.map((d) => d.task_name).join(', ')}`;
    }
    return undefined;
}

export async function promptForTaskArgs(taskName: string, envName?: string): Promise<string | undefined> {
    const envDesc = envName ? ` in environment '${envName}'` : '';
    return window.showInputBox({
        title: `Pixi: Run Task '${taskName}'${envDesc}`,
        prompt: `Additional arguments for '${taskName}' (optional, press Enter to run without arguments)`,
        placeHolder: 'e.g. -k "test_login" --verbose',
    });
}
