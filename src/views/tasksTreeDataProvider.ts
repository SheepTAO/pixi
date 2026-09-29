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

import { escapeRegex } from '../common/execUtils';
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

    public registerCommands(): Disposable {
        const d1 = commands.registerCommand('pixi.tasks.refresh', () => this.refresh());

        const d2 = commands.registerCommand('pixi.tasks.run', async (targetItem?: any) => {
            const task: PixiTask | undefined =
                targetItem?.task || (targetItem?.name && targetItem?.projectPath ? targetItem : undefined);
            if (task) {
                await this.taskProvider.executePixiTask(task);
            } else {
                const projectPath = targetItem?.project?.projectPath || targetItem?.projectPath;
                await commands.executeCommand('pixi.runTask', projectPath);
            }
        });

        const d3 = commands.registerCommand('pixi.tasks.runInEnvironment', async (targetItem?: any) => {
            const task: PixiTask | undefined =
                targetItem?.task || (targetItem?.name && targetItem?.projectPath ? targetItem : undefined);
            const projectPath = targetItem?.project?.projectPath || targetItem?.projectPath;
            await this.taskProvider.promptAndRunTaskInEnvironment(task, projectPath);
        });

        const d4 = commands.registerCommand('pixi.tasks.revealInManifest', async (targetItem?: any) => {
            let task: PixiTask | undefined =
                targetItem?.task || (targetItem?.name && targetItem?.projectPath ? targetItem : undefined);

            if (!task) {
                const targetProjectPath = targetItem?.project?.projectPath || targetItem?.projectPath;
                task = await this.taskProvider.pickTask({
                    title: 'Select Task to Reveal in Manifest',
                    placeHolder: 'Select a task to jump to its definition in manifest',
                    targetProjectPath,
                });
                if (!task) {
                    return;
                }
            }

            const projectPath = task.projectPath;
            const manifestPath = targetItem?.project?.manifestPath || this.projectManager.getManifestPath(projectPath);

            if (!manifestPath || !fs.existsSync(manifestPath)) {
                window.showWarningMessage('Could not find manifest file for this project.');
                return;
            }

            try {
                const doc = await workspace.openTextDocument(Uri.file(manifestPath));
                const editor = await window.showTextDocument(doc);
                const text = doc.getText();
                const lines = text.split(/\r?\n/);
                const escapedName = escapeRegex(task.name);

                const keyRegex = new RegExp(`^\\s*["']?${escapedName}["']?\\s*=`, 'i');
                const sectionRegex = new RegExp(`^\\s*\\[+.*tasks\\.(["']?)${escapedName}\\1\\]`, 'i');

                let targetLine = -1;
                let currentSection = '';
                let matchedViaSection = false;
                // First pass: locate within a tasks table or section header
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const sectionMatch = line.match(/^\s*\[+([^\]]+)\]+/);
                    if (sectionMatch) {
                        currentSection = sectionMatch[1].trim();
                    }

                    if (sectionRegex.test(line)) {
                        targetLine = i;
                        matchedViaSection = true;
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
                    let startCol = 0;
                    let endCol = lineText.length;

                    if (matchedViaSection) {
                        const lastTasksIdx = lineText.toLowerCase().lastIndexOf('tasks.');
                        const searchPart = lastTasksIdx >= 0 ? lineText.slice(lastTasksIdx) : lineText;
                        const m = searchPart.match(new RegExp(`(["']?)(${escapedName})\\1`, 'i'));
                        if (m && m.index !== undefined) {
                            const quoteOffset = m[1] ? m[1].length : 0;
                            startCol = (lastTasksIdx >= 0 ? lastTasksIdx : 0) + m.index + quoteOffset;
                            endCol = startCol + task.name.length;
                        }
                    } else {
                        const eqIdx = lineText.indexOf('=');
                        const searchPart = eqIdx >= 0 ? lineText.slice(0, eqIdx) : lineText;
                        const m = searchPart.match(new RegExp(`(["']?)(${escapedName})\\1`, 'i'));
                        if (m && m.index !== undefined) {
                            const quoteOffset = m[1] ? m[1].length : 0;
                            startCol = m.index + quoteOffset;
                            endCol = startCol + task.name.length;
                        }
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
