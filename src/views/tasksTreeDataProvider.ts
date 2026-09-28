import * as fs from 'fs';
import * as path from 'path';
import {
    commands,
    Disposable,
    Event,
    EventEmitter,
    Position,
    Range,
    Selection,
    TextEditorRevealType,
    ThemeColor,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    TreeView,
    Uri,
    window,
    workspace,
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
        lines.push('\nClick to run task');
        this.tooltip = lines.join('\n');

        this.command = {
            command: 'pixi.tasks.run',
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
        const sorted = [...tasks].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return sorted.map((t) => new PixiTaskTreeItem(t, project));
    }

    public registerCommands(): Disposable {
        const d1 = commands.registerCommand('pixi.tasks.refresh', () => this.refresh());

        const d2 = commands.registerCommand('pixi.tasks.run', async (targetItem?: any) => {
            const task: PixiTask | undefined =
                targetItem?.task || (targetItem?.name && targetItem?.projectPath ? targetItem : undefined);
            if (task) {
                await this.taskProvider.executePixiTask(task);
            } else {
                await commands.executeCommand('pixi.runTask');
            }
        });

        const d3 = commands.registerCommand('pixi.tasks.runInEnvironment', async (targetItem?: any) => {
            const task: PixiTask | undefined =
                targetItem?.task || (targetItem?.name && targetItem?.projectPath ? targetItem : undefined);
            await this.taskProvider.promptAndRunTaskInEnvironment(task);
        });

        const d4 = commands.registerCommand('pixi.tasks.revealInManifest', async (targetItem?: any) => {
            let task: PixiTask | undefined =
                targetItem?.task || (targetItem?.name && targetItem?.projectPath ? targetItem : undefined);

            if (!task) {
                const projectPaths = this.projectManager.getProjectPaths();
                if (projectPaths.length === 0) {
                    window.showWarningMessage('No Pixi projects found in the workspace.');
                    return;
                }
                const allTasks: PixiTask[] = [];
                for (const p of projectPaths) {
                    allTasks.push(...(await this.taskProvider.getTasksForProject(p)));
                }
                if (allTasks.length === 0) {
                    window.showInformationMessage('No Pixi tasks found.');
                    return;
                }
                const isMulti = projectPaths.length > 1;
                const picked = await window.showQuickPick(
                    allTasks.map((t) => {
                        let detail = t.description || t.cmd;
                        if (!detail && t.depends_on && t.depends_on.length > 0) {
                            detail = `depends: ${t.depends_on.map((d) => d.task_name).join(', ')}`;
                        }
                        return {
                            label: t.name,
                            description: [
                                t.default_environment ? `[${t.default_environment}]` : '',
                                isMulti ? `(${path.basename(t.projectPath)})` : '',
                            ]
                                .filter(Boolean)
                                .join(' '),
                            detail,
                            task: t,
                        };
                    }),
                    {
                        title: 'Select Task to Reveal in Manifest',
                        placeHolder: 'Select a task to jump to its definition in manifest',
                        matchOnDescription: true,
                        matchOnDetail: true,
                    },
                );
                if (!picked) {
                    return;
                }
                task = picked.task;
            }

            const projectPath = task.projectPath;
            let manifestPath = targetItem?.project?.manifestPath;
            if (!manifestPath) {
                const p = this.projectManager.getProjects().find((proj) => proj.projectPath === projectPath);
                manifestPath = p?.manifestPath;
            }
            if (!manifestPath) {
                const pixiToml = path.join(projectPath, 'pixi.toml');
                const pyprojectToml = path.join(projectPath, 'pyproject.toml');
                manifestPath = fs.existsSync(pixiToml)
                    ? pixiToml
                    : fs.existsSync(pyprojectToml)
                      ? pyprojectToml
                      : undefined;
            }

            if (!manifestPath || !fs.existsSync(manifestPath)) {
                window.showWarningMessage('Could not find manifest file for this project.');
                return;
            }

            try {
                const doc = await workspace.openTextDocument(Uri.file(manifestPath));
                const editor = await window.showTextDocument(doc);
                const text = doc.getText();
                const lines = text.split(/\r?\n/);
                const escapedName = task.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                const keyRegex = new RegExp(`^\\s*["']?${escapedName}["']?\\s*=`, 'i');
                const sectionRegex = new RegExp(`^\\[+.*tasks\\.${escapedName}\\]+`, 'i');

                let targetLine = -1;
                let currentSection = '';
                // First pass: locate within a tasks table or section header
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const sectionMatch = line.match(/^\s*\[+([^\]]+)\]+/);
                    if (sectionMatch) {
                        currentSection = sectionMatch[1].trim();
                    }

                    if (sectionRegex.test(line)) {
                        targetLine = i;
                        break;
                    }

                    const isTasksSection = /(^|\.)tasks(\.|$)/i.test(currentSection);
                    if (isTasksSection && keyRegex.test(line)) {
                        targetLine = i;
                        break;
                    }
                }

                // Fallback pass: if not found in recognized tasks section, match any key
                if (targetLine < 0) {
                    for (let i = 0; i < lines.length; i++) {
                        if (keyRegex.test(lines[i])) {
                            targetLine = i;
                            break;
                        }
                    }
                }

                if (targetLine >= 0) {
                    const lineText = lines[targetLine];
                    const nameMatch = lineText.match(new RegExp(`(["']?)(${escapedName})\\1`, 'i'));
                    let startCol = 0;
                    let endCol = lineText.length;
                    if (nameMatch && nameMatch.index !== undefined) {
                        const quoteOffset = nameMatch[1] ? nameMatch[1].length : 0;
                        startCol = nameMatch.index + quoteOffset;
                        endCol = startCol + task.name.length;
                    }
                    const startPos = new Position(targetLine, startCol);
                    const endPos = new Position(targetLine, endCol);
                    editor.selection = new Selection(startPos, endPos);
                    editor.revealRange(new Range(startPos, endPos), TextEditorRevealType.InCenter);
                } else {
                    window.showInformationMessage(
                        `Could not locate task definition for '${task.name}' in ${path.basename(manifestPath)}.`,
                    );
                }
            } catch (err) {
                window.showErrorMessage(`Failed to open manifest: ${err instanceof Error ? err.message : String(err)}`);
            }
        });

        return Disposable.from(d1, d2, d3, d4);
    }
}
