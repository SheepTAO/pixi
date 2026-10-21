import {
    Disposable,
    Event,
    EventEmitter,
    MarkdownString,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
} from 'vscode';

import {
    getToolVersion,
    listGlobalEnvironments,
    onDidChangeGlobalEnvironments,
    PixiGlobalEnvironment,
} from '../cli/globalCli';

export class PixiGlobalToolTreeItem extends TreeItem {
    constructor(public readonly tool: PixiGlobalEnvironment) {
        super(tool.name, TreeItemCollapsibleState.None);

        const version = getToolVersion(tool);
        this.description = version;
        this.iconPath = new ThemeIcon('tools');
        this.contextValue = 'pixiGlobalTool';

        const md = new MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;

        const versionHeading = version ? ` \`${version}\`` : '';
        md.appendMarkdown(`### $(tools) ${tool.name}${versionHeading}\n\n`);

        const details: string[] = [];
        if (tool.exposed && tool.exposed.length > 0) {
            details.push(`- **Exposed Commands**: ${tool.exposed.map((e) => `\`${e.exposed_name}\``).join(', ')}`);
        }
        if (tool.dependencies && tool.dependencies.length > 1) {
            const extraDeps = tool.dependencies
                .slice(1)
                .map((d) => `\`${d.name} (${d.version})\``)
                .join(', ');
            details.push(`- **Extra Dependencies**: ${extraDeps}`);
        }
        if (details.length > 0) {
            md.appendMarkdown(details.join('\n') + '\n\n');
        }

        md.appendMarkdown('---\n\n*Right-click for options*');
        this.tooltip = md;
    }
}

export type PixiGlobalTreeItem = PixiGlobalToolTreeItem;

export class PixiGlobalTreeDataProvider implements TreeDataProvider<PixiGlobalTreeItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiGlobalTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiGlobalTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];

    constructor() {
        this.disposables.push(onDidChangeGlobalEnvironments(() => this.refresh()));
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
        Disposable.from(...this.disposables).dispose();
    }

    public getTreeItem(element: PixiGlobalTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: PixiGlobalTreeItem): Promise<PixiGlobalTreeItem[]> {
        if (!element) {
            const tools = await listGlobalEnvironments();
            return tools?.map((tool) => new PixiGlobalToolTreeItem(tool)) ?? [];
        }

        return [];
    }
}
