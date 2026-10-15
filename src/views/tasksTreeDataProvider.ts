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
import {
    DEFAULT_TASK_PREFIX_SEPARATORS,
    formatTaskDetail,
    PixiTask,
    PixiTaskProvider,
} from '../providers/taskProvider';
import { PixiProjectTreeItem } from './projectsTreeDataProvider';

interface TaskIconRule {
    keywords: readonly string[];
    icon: string;
    color?: string;
}

const TASK_ICON_RULES: readonly TaskIconRule[] = [
    { keywords: ['test'], icon: 'beaker', color: 'charts.green' },
    { keywords: ['bench', 'profile', 'eval'], icon: 'pulse', color: 'charts.yellow' },
    { keywords: ['build', 'compile', 'pkg'], icon: 'tools', color: 'charts.orange' },
    { keywords: ['deploy', 'release', 'publish', 'upload'], icon: 'rocket', color: 'charts.red' },
    { keywords: ['run', 'start', 'serve', 'sim', 'app'], icon: 'play', color: 'charts.blue' },
    { keywords: ['lint', 'check', 'format', 'fmt'], icon: 'check-all', color: 'charts.purple' },
    { keywords: ['preprocess', 'data', 'prep', 'etl'], icon: 'database', color: 'charts.blue' },
    { keywords: ['install', 'download', 'fetch', 'pull', 'update'], icon: 'cloud-download', color: 'charts.blue' },
    { keywords: ['watch', 'monitor'], icon: 'eye', color: 'charts.cyan' },
    { keywords: ['clean'], icon: 'clear-all', color: 'descriptionForeground' },
    { keywords: ['doc'], icon: 'book', color: 'charts.yellow' },
    { keywords: ['sync', 'setup'], icon: 'sync', color: 'charts.green' },
];

function resolveTaskIcon(taskName: string): ThemeIcon {
    const lower = taskName.toLowerCase();
    for (const rule of TASK_ICON_RULES) {
        if (rule.keywords.some((kw) => lower.includes(kw))) {
            return rule.color ? new ThemeIcon(rule.icon, new ThemeColor(rule.color)) : new ThemeIcon(rule.icon);
        }
    }
    return new ThemeIcon('terminal-view-icon');
}

export class PixiTaskTreeItem extends TreeItem {
    constructor(
        public readonly task: PixiTask,
        public readonly project: PixiProject,
    ) {
        super(task.name, TreeItemCollapsibleState.None);

        const envTag = task.default_environment ? `[${task.default_environment}]` : '';
        const descText = formatTaskDetail(task);
        this.description = [envTag, descText].filter(Boolean).join(' ');

        // Intelligent Codicon matching based on task name semantics
        this.iconPath = resolveTaskIcon(task.name);

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
    constructor(public readonly project: PixiProject) {
        super('No tasks found', TreeItemCollapsibleState.None);
        const manifestName = path.basename(project.manifestPath);
        this.description = '(click to add task)';
        this.tooltip = `No tasks defined in ${project.name}. Click to add a task, or define under [tasks] in ${manifestName}.`;
        this.iconPath = new ThemeIcon('plus', new ThemeColor('charts.blue'));
        this.contextValue = 'pixiTaskEmpty';
        this.command = {
            command: 'pixi.tasks.addTask',
            title: 'Add Task',
            arguments: [{ project }],
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

export type PixiTasksTreeItem = PixiProjectTreeItem | PixiTaskGroupTreeItem | PixiTaskTreeItem | PixiTaskEmptyTreeItem;

export class PixiTasksTreeDataProvider implements TreeDataProvider<PixiTasksTreeItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiTasksTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiTasksTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];

    constructor(
        private readonly projectManager: PixiProjectManager,
        private readonly taskProvider: PixiTaskProvider,
    ) {
        this.disposables.push(
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

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
        Disposable.from(...this.disposables).dispose();
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
            return projects.map((p) => new PixiProjectTreeItem(p));
        }

        if (element instanceof PixiProjectTreeItem) {
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

        const prefixSeparators = config.get<string[]>('prefixSeparators', DEFAULT_TASK_PREFIX_SEPARATORS);
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

        const patterns = prefixSeparators
            .filter(Boolean)
            .sort((a, b) => b.length - a.length)
            .map(escapeRegex);
        const sepRegex = patterns.length > 0 ? new RegExp(patterns.join('|')) : /::|[-_:]/;

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

    private getTaskGroupChildren(groupItem: PixiTaskGroupTreeItem): PixiTasksTreeItem[] {
        const project = groupItem.project;
        if (groupItem.groupType === 'prefix') {
            const config = workspace.getConfiguration('pixi.tasks', Uri.file(project.projectPath));
            const maxDepth = Math.max(1, Math.min(3, config.get<number>('maxDepth', 1)));
            if (groupItem.depth < maxDepth) {
                const prefixSeparators = config.get<string[]>('prefixSeparators', DEFAULT_TASK_PREFIX_SEPARATORS);
                const minGroupSize = Math.max(1, config.get<number>('minGroupSize', 2));
                return this.groupTasksByPrefix(
                    groupItem.tasks,
                    project,
                    prefixSeparators,
                    minGroupSize,
                    groupItem.depth + 1,
                );
            }
        }

        return groupItem.tasks.map((t) => new PixiTaskTreeItem(t, project));
    }
}
