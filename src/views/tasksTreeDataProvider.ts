import * as path from 'path';
import {
    Disposable,
    Event,
    EventEmitter,
    ThemeColor,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    workspace,
} from 'vscode';

import { escapeRegex } from '../common/execUtils';
import { PixiProjectManager } from '../core/projectManager';
import { PixiProject } from '../core/types';
import { PixiTask, PixiTaskProvider } from '../providers/taskProvider';

export class PixiTaskProjectTreeItem extends TreeItem {
    get projectPath(): string {
        return this.project.projectPath;
    }
    get manifestPath(): string {
        return this.project.manifestPath;
    }

    constructor(public readonly project: PixiProject) {
        super(project.name, TreeItemCollapsibleState.Expanded);
        this.description = path.basename(project.manifestPath);
        this.tooltip = `Project: ${project.name}\nPath: ${project.projectPath}`;
        this.iconPath = new ThemeIcon('root-folder');
        this.contextValue = 'pixiTaskProject';
    }
}

export class PixiTaskTreeItem extends TreeItem {
    get projectPath(): string | undefined {
        return this.project?.projectPath || this.task.projectPath;
    }
    get manifestPath(): string | undefined {
        return this.project?.manifestPath;
    }

    constructor(
        public readonly task: PixiTask,
        public readonly project?: PixiProject,
    ) {
        super(task.name, TreeItemCollapsibleState.None);

        const envTag = task.default_environment ? `[${task.default_environment}]` : '';
        let descText = task.description || task.cmd;
        if (!descText && task.depends_on && task.depends_on.length > 0) {
            descText = `depends: ${task.depends_on.map((d) => d.task_name).join(', ')}`;
        }
        this.description = [envTag, descText].filter(Boolean).join(' ');

        // Intelligent Codicon matching based on task name semantics
        const lower = task.name.toLowerCase();
        if (lower.includes('test')) {
            this.iconPath = new ThemeIcon('beaker', new ThemeColor('charts.green'));
        } else if (lower.includes('bench') || lower.includes('profile') || lower.includes('eval')) {
            this.iconPath = new ThemeIcon('pulse', new ThemeColor('charts.yellow'));
        } else if (lower.includes('build') || lower.includes('compile') || lower.includes('pkg')) {
            this.iconPath = new ThemeIcon('tools', new ThemeColor('charts.orange'));
        } else if (
            lower.includes('deploy') ||
            lower.includes('release') ||
            lower.includes('publish') ||
            lower.includes('upload')
        ) {
            this.iconPath = new ThemeIcon('rocket', new ThemeColor('charts.red'));
        } else if (
            lower.includes('run') ||
            lower.includes('start') ||
            lower.includes('serve') ||
            lower.includes('sim') ||
            lower.includes('app')
        ) {
            this.iconPath = new ThemeIcon('play', new ThemeColor('charts.blue'));
        } else if (
            lower.includes('lint') ||
            lower.includes('check') ||
            lower.includes('format') ||
            lower.includes('fmt')
        ) {
            this.iconPath = new ThemeIcon('check-all', new ThemeColor('charts.purple'));
        } else if (
            lower.includes('preprocess') ||
            lower.includes('data') ||
            lower.includes('prep') ||
            lower.includes('etl')
        ) {
            this.iconPath = new ThemeIcon('database', new ThemeColor('charts.blue'));
        } else if (
            lower.includes('install') ||
            lower.includes('download') ||
            lower.includes('fetch') ||
            lower.includes('pull') ||
            lower.includes('update')
        ) {
            this.iconPath = new ThemeIcon('cloud-download', new ThemeColor('charts.blue'));
        } else if (lower.includes('watch') || lower.includes('monitor')) {
            this.iconPath = new ThemeIcon('eye', new ThemeColor('charts.cyan'));
        } else if (lower.includes('clean')) {
            this.iconPath = new ThemeIcon('clear-all', new ThemeColor('descriptionForeground'));
        } else if (lower.includes('doc')) {
            this.iconPath = new ThemeIcon('book', new ThemeColor('charts.yellow'));
        } else if (lower.includes('sync') || lower.includes('setup')) {
            this.iconPath = new ThemeIcon('sync', new ThemeColor('charts.green'));
        } else {
            this.iconPath = new ThemeIcon('terminal-view-icon');
        }

        const lines = [`Task: ${task.name}`];
        if (task.cmd) {
            lines.push(`Command: ${task.cmd}`);
        }
        if (task.description) {
            lines.push(`Description: ${task.description}`);
        }
        if (task.default_environment) {
            lines.push(`Environment: ${task.default_environment}`);
        }
        if (task.depends_on && task.depends_on.length > 0) {
            const deps = task.depends_on.map((d) => d.task_name).join(', ');
            lines.push(`Depends on: ${deps}`);
        }
        if (task.inputs && task.inputs.length > 0) {
            lines.push(`Inputs: ${task.inputs.join(', ')}`);
        }
        if (task.outputs && task.outputs.length > 0) {
            lines.push(`Outputs: ${task.outputs.join(', ')}`);
        }
        if (task.clean_env) {
            lines.push('Clean environment: yes');
        }
        lines.push('\nClick to run task');
        this.tooltip = lines.join('\n');

        this.command = {
            command: 'pixi.runTask',
            title: 'Run Task',
            arguments: [this],
        };

        this.contextValue = 'pixiTaskItem';
    }
}

export class PixiTaskEmptyTreeItem extends TreeItem {
    constructor(public readonly project?: PixiProject) {
        super('No tasks found', TreeItemCollapsibleState.None);
        const manifestName = project ? path.basename(project.manifestPath) : 'manifest';
        this.description = '(click to add task)';
        this.tooltip = project
            ? `No tasks defined in ${project.name}. Click to add a task, or define under [tasks] in ${manifestName}.`
            : 'No tasks found. Click to add a task.';
        this.iconPath = new ThemeIcon('plus', new ThemeColor('charts.blue'));
        this.contextValue = 'pixiTaskEmpty';
        this.command = {
            command: 'pixi.tasks.addTask',
            title: 'Add Task',
            arguments: [project ? { project } : undefined],
        };
    }
}

export class PixiTaskGroupTreeItem extends TreeItem {
    constructor(
        public readonly groupName: string,
        public readonly tasks: PixiTask[],
        public readonly project: PixiProject,
        public readonly groupType: 'prefix' | 'environment' = 'prefix',
        public readonly depth: number = 1,
    ) {
        super(groupName, TreeItemCollapsibleState.Expanded);
        this.description = `(${tasks.length})`;
        this.tooltip =
            groupType === 'environment'
                ? `Environment '${groupName}': ${tasks.length} task(s)`
                : `Task Group '${groupName}': ${tasks.length} task(s)`;
        this.iconPath = groupType === 'environment' ? new ThemeIcon('layers') : new ThemeIcon('folder');
        this.contextValue = 'pixiTaskGroup';
    }
}

export type PixiTasksTreeItem =
    | PixiTaskProjectTreeItem
    | PixiTaskGroupTreeItem
    | PixiTaskTreeItem
    | PixiTaskEmptyTreeItem;

export class PixiTasksTreeDataProvider implements TreeDataProvider<PixiTasksTreeItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiTasksTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiTasksTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];

    constructor(
        private readonly projectManager: PixiProjectManager,
        private readonly taskProvider: PixiTaskProvider,
    ) {
        this.disposables.push(
            this.projectManager.onDidProjectsChanged(() => this.refresh()),
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
            this.taskProvider.onDidChangeTasks(() => {
                this._onDidChangeTreeData.fire();
            }),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.tasks')) {
                    this._onDidChangeTreeData.fire();
                }
            }),
        );
    }

    public refresh(): void {
        this.taskProvider.refresh();
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    public getTreeItem(element: PixiTasksTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: PixiTasksTreeItem): Promise<PixiTasksTreeItem[]> {
        const projects = this.projectManager.getProjects();
        if (projects.length === 0) {
            return [];
        }

        if (!element) {
            if (projects.length === 1) {
                const singleProject = projects[0];
                return this.getTaskItemsForProject(singleProject);
            }
            return projects.map((p) => new PixiTaskProjectTreeItem(p));
        }

        if (element instanceof PixiTaskProjectTreeItem) {
            return this.getTaskItemsForProject(element.project);
        }

        if (element instanceof PixiTaskGroupTreeItem) {
            return this.getTaskGroupChildren(element);
        }

        return [];
    }

    private async getTaskItemsForProject(project: PixiProject): Promise<PixiTasksTreeItem[]> {
        const tasks = await this.taskProvider.getTasksForProject(project.projectPath);
        if (tasks.length === 0) {
            return [new PixiTaskEmptyTreeItem(project)];
        }

        const config = workspace.getConfiguration('pixi.tasks', Uri.file(project.projectPath));
        const groupBy = config.get<'prefix' | 'environment' | 'none'>('groupBy', 'prefix');

        if (groupBy === 'none') {
            return tasks.map((t) => new PixiTaskTreeItem(t, project));
        }

        if (groupBy === 'environment') {
            return this.groupTasksByEnvironment(tasks, project);
        }

        const prefixSeparators = config.get<string[]>('prefixSeparators', ['-', '_']);
        const minGroupSize = Math.max(1, config.get<number>('minGroupSize', 2));

        return this.groupTasksByPrefix(tasks, project, prefixSeparators, minGroupSize, 1);
    }

    private groupTasksByEnvironment(tasks: PixiTask[], project: PixiProject): PixiTasksTreeItem[] {
        const envMap = new Map<string, PixiTask[]>();

        for (const task of tasks) {
            const envName = task.default_environment || 'default';
            let list = envMap.get(envName);
            if (!list) {
                list = [];
                envMap.set(envName, list);
            }
            list.push(task);
        }

        const groups: PixiTasksTreeItem[] = [];
        const envNames = Array.from(envMap.keys()).sort((a, b) => {
            if (a === 'default') {
                return -1;
            }
            if (b === 'default') {
                return 1;
            }
            return a.localeCompare(b);
        });

        for (const envName of envNames) {
            const envTasks = envMap.get(envName)!;
            groups.push(new PixiTaskGroupTreeItem(envName, envTasks, project, 'environment', 1));
        }

        return groups;
    }

    private groupTasksByPrefix(
        tasks: PixiTask[],
        project: PixiProject,
        prefixSeparators: string[],
        minGroupSize: number,
        currentDepth: number,
    ): PixiTasksTreeItem[] {
        const groupMap = new Map<string, PixiTask[]>();
        const rootTasks: PixiTask[] = [];

        const patterns = (prefixSeparators || [])
            .filter(Boolean)
            .slice()
            .sort((a, b) => b.length - a.length)
            .map(escapeRegex);
        const sepRegex = patterns.length > 0 ? new RegExp(patterns.join('|')) : /[-_]/;

        for (const task of tasks) {
            const parts = task.name.split(sepRegex).filter(Boolean);
            if (parts.length < currentDepth + 1) {
                rootTasks.push(task);
                continue;
            }

            const prefix = parts[currentDepth - 1];
            let list = groupMap.get(prefix);
            if (!list) {
                list = [];
                groupMap.set(prefix, list);
            }
            list.push(task);
        }

        const items: PixiTasksTreeItem[] = [];

        // Groups meeting or exceeding minGroupSize
        const validPrefixes = Array.from(groupMap.keys())
            .filter((p) => groupMap.get(p)!.length >= minGroupSize)
            .sort((a, b) => a.localeCompare(b));

        for (const prefix of validPrefixes) {
            const groupTasks = groupMap.get(prefix)!;
            items.push(new PixiTaskGroupTreeItem(prefix, groupTasks, project, 'prefix', currentDepth));
        }

        // Sub-threshold tasks are kept flat
        for (const groupTasks of groupMap.values()) {
            if (groupTasks.length < minGroupSize) {
                rootTasks.push(...groupTasks);
            }
        }

        rootTasks.sort((a, b) => a.name.localeCompare(b.name));
        for (const task of rootTasks) {
            items.push(new PixiTaskTreeItem(task, project));
        }

        return items;
    }

    private async getTaskGroupChildren(groupItem: PixiTaskGroupTreeItem): Promise<PixiTasksTreeItem[]> {
        const project = groupItem.project;
        if (groupItem.groupType === 'environment') {
            return groupItem.tasks
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => new PixiTaskTreeItem(t, project));
        }

        const config = workspace.getConfiguration('pixi.tasks', Uri.file(project.projectPath));
        const maxDepth = Math.max(1, Math.min(3, config.get<number>('maxDepth', 1)));
        const prefixSeparators = config.get<string[]>('prefixSeparators', ['-', '_']);
        const minGroupSize = Math.max(1, config.get<number>('minGroupSize', 2));

        if (groupItem.depth < maxDepth) {
            return this.groupTasksByPrefix(
                groupItem.tasks,
                project,
                prefixSeparators,
                minGroupSize,
                groupItem.depth + 1,
            );
        }

        return groupItem.tasks
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => new PixiTaskTreeItem(t, project));
    }
}
