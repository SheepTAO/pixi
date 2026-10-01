import * as path from 'path';
import {
    CancellationToken,
    CodeLens,
    CodeLensProvider,
    Disposable,
    DocumentFilter,
    Event,
    EventEmitter,
    languages,
    Range,
    TextDocument,
    workspace,
} from 'vscode';

import { PixiProjectManager } from '../core/projectManager';
import { PixiTask, PixiTaskProvider } from './taskProvider';

interface ParsedTaskLine {
    name: string;
    line: number;
    env?: string;
}

export class PixiTaskCodeLensProvider implements CodeLensProvider, Disposable {
    private readonly _onDidChangeCodeLenses = new EventEmitter<void>();
    public readonly onDidChangeCodeLenses: Event<void> = this._onDidChangeCodeLenses.event;
    private readonly disposables: Disposable[] = [];

    constructor(
        private readonly projectManager: PixiProjectManager,
        private readonly taskProvider: PixiTaskProvider,
    ) {
        const selectors: DocumentFilter[] = [
            { scheme: 'file', pattern: '**/pixi.toml' },
            { scheme: 'file', pattern: '**/pyproject.toml' },
        ];
        this.disposables.push(languages.registerCodeLensProvider(selectors, this));

        this.disposables.push(
            this.taskProvider.onDidChangeTasks(() => this.refresh()),
            this.projectManager.onDidProjectsChanged(() => this.refresh()),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.tasks.codeLens')) {
                    this.refresh();
                }
            }),
        );
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        const config = workspace.getConfiguration('pixi.tasks', document.uri);
        if (!config.get<boolean>('codeLens', true)) {
            return [];
        }

        const fileName = path.basename(document.uri.fsPath);
        if (fileName !== 'pixi.toml' && fileName !== 'pyproject.toml') {
            return [];
        }

        const parsedTasks = this.parseTasksFromDocument(document);
        if (parsedTasks.length === 0 || token.isCancellationRequested) {
            return [];
        }

        const projectPath = path.dirname(document.uri.fsPath);
        const projectTasks = await this.taskProvider.getTasksForProject(projectPath);
        if (token.isCancellationRequested) {
            return [];
        }

        const taskMap = new Map<string, PixiTask>();
        for (const t of projectTasks) {
            taskMap.set(t.name, t);
        }

        const lenses: CodeLens[] = [];
        for (const parsed of parsedTasks) {
            if (token.isCancellationRequested) {
                return [];
            }

            const range = new Range(parsed.line, 0, parsed.line, 0);
            const knownTask = taskMap.get(parsed.name);
            const taskEnv = parsed.env || knownTask?.default_environment;

            const pixiTask: PixiTask = knownTask
                ? {
                      ...knownTask,
                      default_environment: taskEnv,
                  }
                : {
                      name: parsed.name,
                      projectPath,
                      default_environment: taskEnv,
                  };

            // 1. Run Task
            const runTitle = taskEnv ? `$(play) Run Task (${taskEnv})` : '$(play) Run Task';
            const depDetails =
                pixiTask.depends_on && pixiTask.depends_on.length > 0
                    ? ` (depends on: ${pixiTask.depends_on.map((d) => d.task_name).join(', ')})`
                    : '';
            const runTooltip = `Run Pixi task '${pixiTask.name}' in terminal${depDetails}`;

            lenses.push(
                new CodeLens(range, {
                    title: runTitle,
                    command: 'pixi.runTask',
                    tooltip: runTooltip,
                    arguments: [{ task: pixiTask }],
                }),
            );

            // 2. Run in Environment...
            lenses.push(
                new CodeLens(range, {
                    title: '$(layers) Run in Environment...',
                    command: 'pixi.runTaskInEnvironment',
                    tooltip: `Select an environment to run '${pixiTask.name}'`,
                    arguments: [{ task: pixiTask }],
                }),
            );
        }

        return lenses;
    }

    private parseTasksFromDocument(document: TextDocument): ParsedTaskLine[] {
        const isPyproject = path.basename(document.uri.fsPath) === 'pyproject.toml';
        const tasks: ParsedTaskLine[] = [];
        const lineCount = document.lineCount;

        let currentSection = '';
        let inTaskPropertiesTable = false;
        let isTasksContainer = false;
        let currentEnv: string | undefined;
        let braceDepth = 0;
        let bracketDepth = 0;

        for (let i = 0; i < lineCount; i++) {
            const line = document.lineAt(i).text;
            const trimmed = line.trim();

            if (trimmed.startsWith('#') || trimmed.length === 0) {
                continue;
            }

            const sectionMatch = line.match(/^\s*\[+([^\]]+)\]+/);
            if (sectionMatch) {
                currentSection = sectionMatch[1].trim();
                braceDepth = 0;
                bracketDepth = 0;
                inTaskPropertiesTable = false;
                isTasksContainer = false;
                currentEnv = undefined;

                if (isPyproject && !currentSection.startsWith('tool.pixi.')) {
                    continue;
                }

                const taskHeaderMatch = currentSection.match(/(?:^|\.)tasks\.(?:(["'])(.+?)\1|([^.[\]\s]+))$/i);
                if (taskHeaderMatch) {
                    inTaskPropertiesTable = true;
                    const taskName = taskHeaderMatch[2] ?? taskHeaderMatch[3];
                    const featMatch = currentSection.match(/(?:^|\.)feature\.([^.]+)\.tasks\./i);
                    const envMatch = currentSection.match(/(?:^|\.)environments\.([^.]+)\.tasks\./i);
                    const env = featMatch ? featMatch[1] : envMatch ? envMatch[1] : undefined;
                    tasks.push({ name: taskName, line: i, env });
                } else if (/(?:^|\.)tasks$/i.test(currentSection)) {
                    isTasksContainer = true;
                    const featMatch = currentSection.match(/(?:^|\.)feature\.([^.]+)\.tasks$/i);
                    const envMatch = currentSection.match(/(?:^|\.)environments\.([^.]+)\.tasks$/i);
                    currentEnv = featMatch ? featMatch[1] : envMatch ? envMatch[1] : undefined;
                }
                continue;
            }

            if (inTaskPropertiesTable) {
                continue;
            }

            if (isTasksContainer) {
                if (braceDepth === 0 && bracketDepth === 0) {
                    const kvMatch = line.match(/^\s*(?:(["'])(.*?)\1|([a-zA-Z0-9_\-\.]+))\s*=/);
                    if (kvMatch) {
                        const taskName = kvMatch[2] ?? kvMatch[3];
                        tasks.push({ name: taskName, line: i, env: currentEnv });
                    }
                }

                const withoutStrings = line.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
                const withoutComment = withoutStrings.replace(/#.*$/, '');
                for (const ch of withoutComment) {
                    if (ch === '{') {
                        braceDepth++;
                    } else if (ch === '}') {
                        braceDepth = Math.max(0, braceDepth - 1);
                    } else if (ch === '[') {
                        bracketDepth++;
                    } else if (ch === ']') {
                        bracketDepth = Math.max(0, bracketDepth - 1);
                    }
                }
            }
        }

        return tasks;
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
        this._onDidChangeCodeLenses.dispose();
    }
}
