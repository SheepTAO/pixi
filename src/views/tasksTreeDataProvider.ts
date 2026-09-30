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
    TreeView,
    Uri,
} from 'vscode';

import { PixiProjectManager } from '../core/projectManager';
import { PixiProject } from '../core/types';
import { PixiTask, PixiTaskProvider } from '../providers/taskProvider';

export class PixiTaskProjectTreeItem extends TreeItem {
    constructor(public readonly project: PixiProject) {
        super(project.name, TreeItemCollapsibleState.Expanded);
        this.description = path.basename(project.manifestPath);
        this.tooltip = `Project: ${project.name}\nPath: ${project.projectPath}`;
        this.iconPath = new ThemeIcon('root-folder');
        this.contextValue = 'pixiTaskProject';
    }
}

export class PixiTaskTreeItem extends TreeItem {
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
        } else if (lower.includes('build') || lower.includes('compile') || lower.includes('pkg')) {
            this.iconPath = new ThemeIcon('tools', new ThemeColor('charts.orange'));
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
        } else if (lower.includes('clean')) {
            this.iconPath = new ThemeIcon('clear-all');
        } else if (lower.includes('doc')) {
            this.iconPath = new ThemeIcon('book');
        } else if (lower.includes('sync') || lower.includes('setup')) {
            this.iconPath = new ThemeIcon('sync');
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
        this.description = `(define tasks in ${manifestName})`;
        this.tooltip = project
            ? `No tasks defined in ${project.name}. Define tasks under [tasks] in ${manifestName}.`
            : 'No tasks found. Define tasks under [tasks] in your manifest.';
        this.iconPath = new ThemeIcon('info', new ThemeColor('descriptionForeground'));
        this.contextValue = 'pixiTaskEmpty';
        if (project) {
            this.command = {
                command: 'vscode.open',
                title: 'Open Manifest',
                arguments: [Uri.file(project.manifestPath)],
            };
        }
    }
}

export type PixiTasksTreeItem = PixiTaskProjectTreeItem | PixiTaskTreeItem | PixiTaskEmptyTreeItem;

export class PixiTasksTreeDataProvider implements TreeDataProvider<PixiTasksTreeItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiTasksTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiTasksTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];
    private treeView?: TreeView<PixiTasksTreeItem>;

    constructor(
        private readonly projectManager: PixiProjectManager,
        private readonly taskProvider: PixiTaskProvider,
    ) {
        this.disposables.push(
            this.projectManager.onDidProjectsChanged(() => this.refresh()),
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
            this.taskProvider.onDidChangeTasks(() => {
                this.updateViewDescription();
                this._onDidChangeTreeData.fire();
            }),
        );
    }

    public bindView(treeView: TreeView<PixiTasksTreeItem>): void {
        this.treeView = treeView;
        this.updateViewDescription();
    }

    private updateViewDescription(): void {
        if (!this.treeView) {
            return;
        }
        const projects = this.projectManager.getProjects();
        if (projects.length === 1) {
            const manifestName = path.basename(projects[0].manifestPath);
            this.treeView.description = `${projects[0].name} (${manifestName})`;
        } else {
            this.treeView.description = undefined;
        }
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

        return [];
    }

    private async getTaskItemsForProject(project: PixiProject): Promise<PixiTasksTreeItem[]> {
        const tasks = await this.taskProvider.getTasksForProject(project.projectPath);
        if (tasks.length === 0) {
            return [new PixiTaskEmptyTreeItem(project)];
        }
        return tasks.map((t) => new PixiTaskTreeItem(t, project));
    }
}
