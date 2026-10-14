import {
    CancellationToken,
    CodeLens,
    CodeLensProvider,
    Disposable,
    Event,
    EventEmitter,
    Hover,
    HoverProvider,
    languages,
    MarkdownString,
    Position,
    Range,
    TextDocument,
    workspace,
} from 'vscode';

import { encodeCommandArg } from '../common/execUtils';
import { isPyproject, MANIFEST_SELECTORS } from '../core/projectDiscovery';
import { PixiProjectManager } from '../core/projectManager';
import { PixiTask, PixiTaskProvider } from './taskProvider';

export type ManifestActionMode = 'hover' | 'compact' | 'full' | 'header' | 'off';

interface ParsedTaskLine {
    name: string;
    line: number;
    startCol: number;
    endCol: number;
    env?: string;
}

interface ParsedTaskSection {
    line: number;
    section: string;
    env?: string;
}

interface ParsedManifestResult {
    tasks: ParsedTaskLine[];
    sections: ParsedTaskSection[];
}

export class PixiTaskManifestProvider implements CodeLensProvider, HoverProvider, Disposable {
    private readonly _onDidChangeCodeLenses = new EventEmitter<void>();
    public readonly onDidChangeCodeLenses: Event<void> = this._onDidChangeCodeLenses.event;
    private readonly disposables: Disposable[] = [];

    constructor(
        private readonly projectManager: PixiProjectManager,
        private readonly taskProvider: PixiTaskProvider,
    ) {
        this.disposables.push(
            languages.registerCodeLensProvider(MANIFEST_SELECTORS, this),
            languages.registerHoverProvider(MANIFEST_SELECTORS, this),
            this.taskProvider.onDidChangeTasks(() => this.refresh()),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.tasks.manifestActions')) {
                    this.refresh();
                }
            }),
        );
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        const mode = this.getManifestActionMode(document);
        if (mode === 'off' || mode === 'hover') {
            return [];
        }

        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return [];
        }

        const { tasks, sections } = this.parseManifestTasks(document);
        if ((tasks.length === 0 && sections.length === 0) || token.isCancellationRequested) {
            return [];
        }

        // 1. Header mode: Only show an aggregated action line on section headers ([tasks], etc.)
        if (mode === 'header') {
            const headerLenses: CodeLens[] = [];
            for (const sec of sections) {
                const range = new Range(sec.line, 0, sec.line, 0);
                const envLabel = sec.env ? ` (${sec.env})` : '';

                headerLenses.push(
                    new CodeLens(range, {
                        title: `$(play) Run Task...${envLabel}`,
                        command: 'pixi.runTask',
                        tooltip: `Select and run a task from ${sec.section}`,
                        arguments: [projectPath],
                    }),
                    new CodeLens(range, {
                        title: '$(plus) Add Task...',
                        command: 'pixi.tasks.addTask',
                        tooltip: `Add a new task to ${sec.section}`,
                        arguments: [projectPath],
                    }),
                );
            }
            return headerLenses;
        }

        // 2. Per-task CodeLens (compact or full)
        const projectTasks = await this.taskProvider.getTasksForProject(projectPath);
        if (token.isCancellationRequested) {
            return [];
        }

        const taskMap = new Map<string, PixiTask>();
        for (const t of projectTasks) {
            taskMap.set(t.name, t);
        }

        const isCompact = mode === 'compact';
        const lenses: CodeLens[] = [];

        for (const parsed of tasks) {
            if (token.isCancellationRequested) {
                return [];
            }

            const range = new Range(parsed.line, 0, parsed.line, 0);
            const knownTask = taskMap.get(parsed.name);
            const pixiTask: PixiTask = knownTask ?? { name: parsed.name, projectPath, feature: parsed.env };
            const taskEnv = pixiTask.default_environment;

            const depDetails =
                pixiTask.depends_on && pixiTask.depends_on.length > 0
                    ? ` (depends on: ${pixiTask.depends_on.map((d) => d.task_name).join(', ')})`
                    : '';
            const runTooltip = `Run Pixi task '${pixiTask.name}' in terminal${depDetails}`;

            if (isCompact) {
                const compactTitle = taskEnv ? `$(play) Run (${taskEnv})` : '$(play) Run';
                lenses.push(
                    new CodeLens(range, {
                        title: compactTitle,
                        command: 'pixi.runTask',
                        tooltip: runTooltip,
                        arguments: [{ task: pixiTask }],
                    }),
                );
            } else {
                const fullTitle = taskEnv ? `$(play) Run Task (${taskEnv})` : '$(play) Run Task';
                lenses.push(
                    new CodeLens(range, {
                        title: fullTitle,
                        command: 'pixi.runTask',
                        tooltip: runTooltip,
                        arguments: [{ task: pixiTask }],
                    }),
                    new CodeLens(range, {
                        title: '$(terminal) Run with Args...',
                        command: 'pixi.runTaskWithArgs',
                        tooltip: `Run '${pixiTask.name}' with custom arguments in terminal`,
                        arguments: [{ task: pixiTask }],
                    }),
                    new CodeLens(range, {
                        title: '$(layers) Run in Environment...',
                        command: 'pixi.runTaskInEnvironment',
                        tooltip: `Select an environment to run '${pixiTask.name}'`,
                        arguments: [{ task: pixiTask }],
                    }),
                );
            }
        }

        return lenses;
    }

    public async provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
    ): Promise<Hover | undefined> {
        const mode = this.getManifestActionMode(document);
        if (mode !== 'hover') {
            return undefined;
        }

        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return undefined;
        }

        const { tasks } = this.parseManifestTasks(document);
        if (tasks.length === 0 || token.isCancellationRequested) {
            return undefined;
        }

        const matched = tasks.find(
            (t) => t.line === position.line && position.character >= t.startCol && position.character <= t.endCol,
        );
        if (!matched || token.isCancellationRequested) {
            return undefined;
        }

        const projectTasks = await this.taskProvider.getTasksForProject(projectPath);
        if (token.isCancellationRequested) {
            return undefined;
        }

        const knownTask = projectTasks.find((t) => t.name === matched.name);
        const pixiTask: PixiTask = knownTask ?? { name: matched.name, projectPath, feature: matched.env };
        const taskEnv = pixiTask.default_environment;

        const md = new MarkdownString('', true);
        md.isTrusted = true;
        md.supportThemeIcons = true;

        const envBadge = taskEnv ? ` \`(${taskEnv})\`` : '';
        md.appendMarkdown(`### $(terminal) Pixi Task: **${pixiTask.name}**${envBadge}\n\n`);

        if (pixiTask.description) {
            md.appendMarkdown(`*${pixiTask.description}*\n\n`);
        }
        if (pixiTask.cmd) {
            md.appendMarkdown(`**Command**: \`${pixiTask.cmd}\`\n\n`);
        }
        if (pixiTask.default_environment) {
            md.appendMarkdown(`**Environment**: \`${pixiTask.default_environment}\`\n\n`);
        }
        if (pixiTask.depends_on && pixiTask.depends_on.length > 0) {
            const deps = pixiTask.depends_on.map((d) => `\`${d.task_name}\``).join(', ');
            md.appendMarkdown(`**Depends on**: ${deps}\n\n`);
        }
        if (pixiTask.inputs && pixiTask.inputs.length > 0) {
            md.appendMarkdown(`**Inputs**: ${pixiTask.inputs.map((i) => `\`${i}\``).join(', ')}\n\n`);
        }
        if (pixiTask.outputs && pixiTask.outputs.length > 0) {
            md.appendMarkdown(`**Outputs**: ${pixiTask.outputs.map((o) => `\`${o}\``).join(', ')}\n\n`);
        }
        if (pixiTask.clean_env) {
            md.appendMarkdown('**Clean Environment**: yes\n\n');
        }

        md.appendMarkdown('---\n\n');

        const runArg = encodeCommandArg({ task: pixiTask });
        const runUri = `command:pixi.runTask?${runArg}`;
        const runWithArgsUri = `command:pixi.runTaskWithArgs?${runArg}`;
        const runInEnvUri = `command:pixi.runTaskInEnvironment?${runArg}`;
        const removeUri = `command:pixi.tasks.removeTask?${runArg}`;

        md.appendMarkdown(
            `[$(play) Run Task](${runUri} "Run task in terminal") &nbsp;&nbsp;|&nbsp;&nbsp; [$(terminal) Run with Args...](${runWithArgsUri} "Run task with custom arguments") &nbsp;&nbsp;|&nbsp;&nbsp; [$(layers) Run in Environment...](${runInEnvUri} "Select environment to run task") &nbsp;&nbsp;|&nbsp;&nbsp; [$(trash) Remove](${removeUri} "Remove '${pixiTask.name}' from manifest")`,
        );

        const highlightRange = new Range(matched.line, matched.startCol, matched.line, matched.endCol);
        return new Hover(md, highlightRange);
    }

    private getManifestActionMode(document: TextDocument): ManifestActionMode {
        return workspace
            .getConfiguration('pixi.tasks', document.uri)
            .get<ManifestActionMode>('manifestActions', 'hover');
    }

    private parseManifestTasks(document: TextDocument): ParsedManifestResult {
        const isPyprojectDoc = isPyproject(document);
        const tasks: ParsedTaskLine[] = [];
        const sections: ParsedTaskSection[] = [];
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

                if (isPyprojectDoc && !currentSection.startsWith('tool.pixi.')) {
                    continue;
                }

                const taskHeaderMatch = currentSection.match(/(?:^|\.)tasks\.(?:(["'])(.+?)\1|([^.[\]\s]+))$/i);
                if (taskHeaderMatch) {
                    inTaskPropertiesTable = true;
                    const taskName = taskHeaderMatch[2] ?? taskHeaderMatch[3];
                    const env = currentSection.match(/(?:^|\.)(?:feature|environments)\.([^.]+)\.tasks\./i)?.[1];

                    const startCol = Math.max(0, line.indexOf(taskName));
                    const endCol = startCol + taskName.length;
                    tasks.push({ name: taskName, line: i, startCol, endCol, env });
                } else if (/(?:^|\.)tasks$/i.test(currentSection)) {
                    isTasksContainer = true;
                    currentEnv = currentSection.match(/(?:^|\.)(?:feature|environments)\.([^.]+)\.tasks$/i)?.[1];

                    sections.push({ line: i, section: currentSection, env: currentEnv });
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
                        const startCol = Math.max(0, line.indexOf(taskName));
                        const endCol = startCol + taskName.length;
                        tasks.push({ name: taskName, line: i, startCol, endCol, env: currentEnv });
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

        return { tasks, sections };
    }

    public dispose(): void {
        this._onDidChangeCodeLenses.dispose();
        Disposable.from(...this.disposables).dispose();
    }
}
