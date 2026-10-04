import * as fs from 'fs';
import * as path from 'path';
import {
    CancellationToken,
    CompletionItem,
    CompletionItemKind,
    CompletionItemProvider,
    Disposable,
    ExtensionContext,
    Hover,
    HoverProvider,
    languages,
    MarkdownString,
    Position,
    Range,
    SnippetString,
    TextDocument,
    workspace,
} from 'vscode';

import { traceError, traceVerbose } from '../common/logging';

interface SchemaProperty {
    description?: string;
    type?: string;
    title?: string;
    default?: unknown;
    enum?: string[];
    $ref?: string;
}

interface ManifestSchemaMetadata {
    topLevelSections: Map<string, string>;
    workspaceProperties: Map<string, string>;
    taskProperties: Map<string, string>;
    systemRequirementProperties: Map<string, string>;
    pypiOptionProperties: Map<string, string>;
    activationProperties: Map<string, string>;
    environmentProperties: Map<string, string>;
    allPropertiesDoc: Map<string, string>;
}

const COMMON_CHANNELS = [
    { label: 'conda-forge', detail: 'Primary community-led Conda channel (recommended)' },
    { label: 'bioconda', detail: 'Bioinformatics packages channel' },
    { label: 'pytorch', detail: 'Official PyTorch Conda channel' },
    { label: 'nvidia', detail: 'Official NVIDIA CUDA packages channel' },
    { label: 'robostack', detail: 'ROS and robotics packages channel' },
    { label: 'node-forge', detail: 'NodeJS ecosystem Conda channel' },
];

const COMMON_PLATFORMS = [
    { label: 'linux-64', detail: 'Linux x86_64 architecture' },
    { label: 'linux-aarch64', detail: 'Linux ARM64 / aarch64 architecture' },
    { label: 'osx-arm64', detail: 'macOS Apple Silicon (M1/M2/M3/M4)' },
    { label: 'osx-64', detail: 'macOS Intel x86_64 architecture' },
    { label: 'win-64', detail: 'Windows x86_64 architecture' },
    { label: 'win-arm64', detail: 'Windows ARM64 architecture' },
    { label: 'noarch', detail: 'Platform-independent Conda packages' },
];

export class PixiManifestSchemaProvider implements CompletionItemProvider, HoverProvider, Disposable {
    private readonly disposables: Disposable[] = [];
    private schemaMeta: ManifestSchemaMetadata | null = null;
    private schemaLoadingPromise: Promise<ManifestSchemaMetadata | null> | null = null;

    constructor(private readonly context: ExtensionContext) {
        const selectors = [
            { scheme: 'file', pattern: '**/pixi.toml' },
            { scheme: 'file', pattern: '**/pyproject.toml' },
        ];

        this.disposables.push(
            languages.registerCompletionItemProvider(selectors, this, '[', '"', "'", '=', ',', ' '),
            languages.registerHoverProvider(selectors, this),
        );
    }

    public dispose(): void {
        Disposable.from(...this.disposables).dispose();
    }

    private isEnabled(document: TextDocument): boolean {
        return workspace.getConfiguration('pixi', document.uri).get<boolean>('manifest.schemaSupport', true);
    }

    private async getSchemaMetadata(): Promise<ManifestSchemaMetadata | null> {
        if (this.schemaMeta) {
            return this.schemaMeta;
        }

        if (!this.schemaLoadingPromise) {
            this.schemaLoadingPromise = (async () => {
                try {
                    const schemaPath = this.context.asAbsolutePath(path.join('schemas', 'pixi.json'));
                    const raw = await fs.promises.readFile(schemaPath, 'utf8');
                    const schemaJson = JSON.parse(raw);
                    const meta = this.parseSchema(schemaJson);
                    this.schemaMeta = meta;
                    traceVerbose('Loaded Pixi manifest schema definitions from schemas/pixi.json');
                    return meta;
                } catch (err: unknown) {
                    traceError('Failed to load local Pixi manifest schema:', err);
                    return null;
                }
            })();
        }

        return this.schemaLoadingPromise;
    }

    private parseSchema(schemaJson: {
        properties?: Record<string, SchemaProperty>;
        $defs?: Record<string, { properties?: Record<string, SchemaProperty>; description?: string }>;
    }): ManifestSchemaMetadata {
        const topLevelSections = new Map<string, string>();
        const workspaceProperties = new Map<string, string>();
        const taskProperties = new Map<string, string>();
        const systemRequirementProperties = new Map<string, string>();
        const pypiOptionProperties = new Map<string, string>();
        const allPropertiesDoc = new Map<string, string>();

        const topProps = schemaJson.properties || {};
        for (const [key, prop] of Object.entries(topProps)) {
            const desc = prop.description || '';
            topLevelSections.set(key, desc);
            allPropertiesDoc.set(key, desc);
        }

        const defs = schemaJson.$defs || {};

        const wsProps = defs.Workspace?.properties || {};
        for (const [key, prop] of Object.entries(wsProps)) {
            const desc = prop.description || '';
            workspaceProperties.set(key, desc);
            if (!allPropertiesDoc.has(key)) {
                allPropertiesDoc.set(key, desc);
            }
        }

        const taskProps = defs.TaskInlineTable?.properties || {};
        for (const [key, prop] of Object.entries(taskProps)) {
            const desc = prop.description || '';
            taskProperties.set(key, desc);
            if (!allPropertiesDoc.has(key)) {
                allPropertiesDoc.set(key, desc);
            }
        }

        const sysProps = defs.SystemRequirements?.properties || {};
        for (const [key, prop] of Object.entries(sysProps)) {
            const desc = prop.description || '';
            systemRequirementProperties.set(key, desc);
            if (!allPropertiesDoc.has(key)) {
                allPropertiesDoc.set(key, desc);
            }
        }

        // Support official schema PyPIOptions naming
        const pypiProps = defs.PyPIOptions?.properties || defs.PypiOptions?.properties || {};
        for (const [key, prop] of Object.entries(pypiProps)) {
            const desc = prop.description || '';
            pypiOptionProperties.set(key, desc);
            if (!allPropertiesDoc.has(key)) {
                allPropertiesDoc.set(key, desc);
            }
        }

        const activationProperties = new Map<string, string>();
        const actProps = defs.Activation?.properties || {};
        for (const [key, prop] of Object.entries(actProps)) {
            const desc = prop.description || '';
            activationProperties.set(key, desc);
            if (!allPropertiesDoc.has(key)) {
                allPropertiesDoc.set(key, desc);
            }
        }

        const environmentProperties = new Map<string, string>();
        const envProps = defs.Environment?.properties || {};
        for (const [key, prop] of Object.entries(envProps)) {
            const desc = prop.description || '';
            environmentProperties.set(key, desc);
            if (!allPropertiesDoc.has(key)) {
                allPropertiesDoc.set(key, desc);
            }
        }

        return {
            topLevelSections,
            workspaceProperties,
            taskProperties,
            systemRequirementProperties,
            pypiOptionProperties,
            activationProperties,
            environmentProperties,
            allPropertiesDoc,
        };
    }

    public async provideCompletionItems(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
    ): Promise<CompletionItem[] | undefined> {
        if (token.isCancellationRequested || !this.isEnabled(document)) {
            return undefined;
        }

        const meta = await this.getSchemaMetadata();
        if (!meta) {
            return undefined;
        }

        const line = document.lineAt(position.line);
        const lineText = line.text;
        const textBeforeCursor = lineText.substring(0, position.character).trimStart();
        const beforeCursor = lineText.substring(0, position.character);
        const isPyproject = path.basename(document.fileName) === 'pyproject.toml';

        const buildArrayCompletions = (items: Array<{ label: string; detail: string }>, arrayName: string) => {
            const lastQuoteIdx = Math.max(beforeCursor.lastIndexOf('"'), beforeCursor.lastIndexOf("'"));
            const hasOpenQuote = lastQuoteIdx !== -1 && !beforeCursor.substring(lastQuoteIdx + 1).includes(',');
            const afterCursor = lineText.substring(position.character);
            const nextQuoteIdx = afterCursor.search(/["']/);
            const hasCloseQuote = nextQuoteIdx !== -1 && !afterCursor.substring(0, nextQuoteIdx).includes(',');

            let replaceRange: Range | undefined;
            if (hasOpenQuote && hasCloseQuote) {
                replaceRange = new Range(
                    position.line,
                    lastQuoteIdx,
                    position.line,
                    position.character + nextQuoteIdx + 1,
                );
            } else if (hasOpenQuote) {
                replaceRange = new Range(position.line, lastQuoteIdx, position.line, position.character);
            } else {
                const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
                if (wordRange) {
                    replaceRange = wordRange;
                }
            }

            return items.map((entry) => {
                const item = new CompletionItem(entry.label, CompletionItemKind.Value);
                item.insertText = `"${entry.label}"`;
                if (replaceRange) {
                    item.range = replaceRange;
                }
                item.detail = entry.detail;
                item.documentation = new MarkdownString(`${arrayName}: \`${entry.label}\``);
                return item;
            });
        };

        if (this.isInsideArray(document, position, 'channels')) {
            return buildArrayCompletions(COMMON_CHANNELS, 'Conda channel');
        }

        if (this.isInsideArray(document, position, 'platforms')) {
            return buildArrayCompletions(COMMON_PLATFORMS, 'Target platform');
        }

        if (textBeforeCursor.startsWith('[') || textBeforeCursor === '') {
            const items: CompletionItem[] = [];
            const prefix = isPyproject ? 'tool.pixi.' : '';

            // Swallow auto-closed ']' after cursor to avoid duplicate brackets
            const hasLeadingBracket = textBeforeCursor.startsWith('[');
            let replaceRange: Range | undefined;
            if (hasLeadingBracket) {
                const textAfterCursor = lineText.substring(position.character);
                const endChar = textAfterCursor.startsWith(']') ? position.character + 1 : position.character;
                replaceRange = new Range(position.line, line.firstNonWhitespaceCharacterIndex, position.line, endChar);
            }

            const sectionSnippets: Array<{ name: string; snippet: string; doc?: string }> = [
                {
                    name: `${prefix}workspace`,
                    snippet: isPyproject
                        ? '[tool.pixi.workspace]\nchannels = ["conda-forge"]\nplatforms = ["linux-64"]'
                        : '[workspace]\nname = "${1:my-project}"\nchannels = ["conda-forge"]\nplatforms = ["linux-64"]',
                    doc: 'Workspace metadata and global project settings',
                },
                {
                    name: `${prefix}tasks`,
                    snippet: `[${prefix}tasks]\n\${1:start} = "\${2:python main.py}"`,
                    doc: 'Workspace and feature runnable tasks',
                },
                {
                    name: `${prefix}dependencies`,
                    snippet: `[${prefix}dependencies]\n\${1:python} = "\${2:>=3.11}"`,
                    doc: 'Project Conda dependencies',
                },
                {
                    name: `${prefix}pypi-dependencies`,
                    snippet: `[${prefix}pypi-dependencies]\n\${1:requests} = "\${2:*"`,
                    doc: 'Project PyPI dependencies (installed into pixi environments)',
                },
                {
                    name: `${prefix}environments`,
                    snippet: `[${prefix}environments]\ndefault = { solve-group = "default" }\n\${1:dev} = ["\${2:test}"]`,
                    doc: 'Custom environment definitions and feature compositions',
                },
                {
                    name: `${prefix}feature.\${1:name}`,
                    snippet: `[${prefix}feature.\${1:name}.dependencies]\n\${2:pytest} = "*"`,
                    doc: 'Feature-specific dependency set or environment overlay',
                },
                {
                    name: `${prefix}system-requirements`,
                    snippet: `[${prefix}system-requirements]\nlinux = "\${1:5.10}"\ncuda = "\${2:12.0}"`,
                    doc: 'System compatibility constraints (glibc, linux, cuda)',
                },
                {
                    name: `${prefix}build-dependencies`,
                    snippet: `[${prefix}build-dependencies]\n`,
                    doc: 'Build-time Conda dependencies',
                },
                {
                    name: `${prefix}host-dependencies`,
                    snippet: `[${prefix}host-dependencies]\n`,
                    doc: 'Host-time Conda dependencies for compiling or cross-compilation',
                },
                {
                    name: `${prefix}activation`,
                    snippet: `[${prefix}activation]\nscripts = ["\${1:activate.sh}"]`,
                    doc: 'Environment activation scripts and environment variables',
                },
            ];

            for (const sec of sectionSnippets) {
                const item = new CompletionItem(`[${sec.name}]`, CompletionItemKind.Module);
                item.insertText = new SnippetString(sec.snippet);
                if (replaceRange) {
                    item.range = replaceRange;
                }
                item.detail = 'Pixi manifest section';
                item.documentation = new MarkdownString(sec.doc || meta.topLevelSections.get(sec.name) || '');
                items.push(item);
            }

            return items;
        }

        if (lineText.includes('=')) {
            return undefined;
        }

        const activeSection = this.getActiveSection(document, position.line);
        if (!activeSection) {
            return undefined;
        }

        const normalizedSection = activeSection.replace(/^tool\.pixi\./, '');

        if (normalizedSection === 'workspace' || normalizedSection === 'package') {
            return this.buildKeyCompletions(meta.workspaceProperties);
        }

        // Subtask table: [tasks.<name>] or [feature.<feat>.tasks.<name>]
        if (
            (normalizedSection.startsWith('tasks.') || normalizedSection.includes('.tasks.')) &&
            !normalizedSection.endsWith('.tasks')
        ) {
            return this.buildKeyCompletions(meta.taskProperties);
        }

        // Flat tasks table: [tasks] or [feature.<feat>.tasks]
        if (normalizedSection === 'tasks' || normalizedSection.endsWith('.tasks')) {
            const taskSnippets: Array<{ label: string; snippet: string; doc: string }> = [
                {
                    label: 'test',
                    snippet: 'test = "${1:pytest}"',
                    doc: 'Standard test execution task',
                },
                {
                    label: 'start',
                    snippet: 'start = "${1:python main.py}"',
                    doc: 'Primary entrypoint execution task',
                },
                {
                    label: 'build',
                    snippet: 'build = "${1:cargo build}"',
                    doc: 'Build / compilation task',
                },
                {
                    label: 'lint',
                    snippet: 'lint = "${1:ruff check}"',
                    doc: 'Linter task',
                },
            ];
            return taskSnippets.map((t) => {
                const item = new CompletionItem(t.label, CompletionItemKind.Snippet);
                item.insertText = new SnippetString(t.snippet);
                item.detail = 'Pixi task declaration';
                item.documentation = new MarkdownString(t.doc);
                return item;
            });
        }

        if (normalizedSection === 'system-requirements') {
            return this.buildKeyCompletions(meta.systemRequirementProperties);
        }

        if (normalizedSection === 'pypi-options') {
            return this.buildKeyCompletions(meta.pypiOptionProperties);
        }

        if (normalizedSection === 'activation') {
            return this.buildKeyCompletions(meta.activationProperties);
        }

        if (normalizedSection.startsWith('environments.') || normalizedSection === 'environments') {
            return this.buildKeyCompletions(meta.environmentProperties);
        }

        return undefined;
    }

    public async provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
    ): Promise<Hover | undefined> {
        if (token.isCancellationRequested || !this.isEnabled(document)) {
            return undefined;
        }

        const activeSection = this.getActiveSection(document, position.line);
        const normalizedSection = (activeSection || '').replace(/^tool\.pixi\./, '');

        const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
        if (!wordRange) {
            return undefined;
        }

        const lineText = document.lineAt(position.line).text;
        const isHeader = lineText.trim().startsWith('[') && lineText.includes(document.getText(wordRange));

        // Skip package rows in dependency tables so PixiDependencyManifestProvider can show rich package cards
        if (!isHeader && (normalizedSection.endsWith('dependencies') || normalizedSection === 'constraints')) {
            return undefined;
        }

        if (!isHeader) {
            const eqIndex = lineText.indexOf('=');
            if (eqIndex !== -1 && wordRange.start.character > eqIndex) {
                return undefined;
            }
        }

        const word = document.getText(wordRange);
        const meta = await this.getSchemaMetadata();
        if (!meta) {
            return undefined;
        }

        const doc = meta.allPropertiesDoc.get(word) || meta.topLevelSections.get(word);
        if (!doc) {
            return undefined;
        }

        const md = new MarkdownString();
        md.isTrusted = true;
        if (isHeader) {
            md.appendMarkdown(`### Pixi Manifest Section: \`[${word}]\`\n\n`);
        } else {
            md.appendMarkdown(`### Pixi Manifest Property: \`${word}\`\n\n`);
        }
        md.appendMarkdown(doc);
        md.appendMarkdown('\n\n---\n*Loaded offline from Pixi JSON Schema*');

        return new Hover(md, wordRange);
    }

    private buildKeyCompletions(propertiesMap: Map<string, string>): CompletionItem[] {
        const arrayProps = new Set([
            'channels',
            'platforms',
            'authors',
            'depends-on',
            'inputs',
            'outputs',
            'scripts',
            'features',
        ]);

        const items: CompletionItem[] = [];
        for (const [key, desc] of propertiesMap.entries()) {
            const item = new CompletionItem(key, CompletionItemKind.Property);
            item.insertText = arrayProps.has(key)
                ? new SnippetString(`${key} = ["\${1}"]`)
                : new SnippetString(`${key} = "\${1}"`);
            item.detail = 'Pixi manifest property';
            item.documentation = new MarkdownString(desc);
            items.push(item);
        }
        return items;
    }

    private getActiveSection(document: TextDocument, currentLine: number): string | null {
        for (let i = currentLine; i >= 0; i--) {
            const text = document.lineAt(i).text.trim();
            const match = text.match(/^\[([A-Za-z0-9_.-]+)\]/);
            if (match) {
                return match[1];
            }
        }
        return null;
    }

    private isInsideArray(document: TextDocument, position: Position, arrayKey: string): boolean {
        const line = document.lineAt(position.line).text;
        const beforeCursor = line.substring(0, position.character);

        const singleLineMatch = new RegExp(`${arrayKey}\\s*=\\s*\\[[^\\]]*$`).test(beforeCursor);
        if (singleLineMatch) {
            return true;
        }

        if (beforeCursor.includes(']')) {
            return false;
        }

        let foundClosing = false;
        for (let i = position.line - 1; i >= Math.max(0, position.line - 15); i--) {
            const text = document.lineAt(i).text;
            if (text.includes(']')) {
                foundClosing = true;
            }
            if (new RegExp(`^\\s*${arrayKey}\\s*=\\s*\\[`).test(text)) {
                return !foundClosing;
            }
            if (text.trim().startsWith('[')) {
                break;
            }
        }

        return false;
    }
}
