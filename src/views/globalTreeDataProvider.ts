import {
    Disposable,
    Event,
    EventEmitter,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
} from 'vscode';

import {
    listGlobalEnvironments,
    onDidChangeGlobalEnvironments,
    PixiGlobalEnvironment,
    PixiGlobalExposed,
} from '../cli/globalCli';

export class PixiGlobalToolTreeItem extends TreeItem {
    constructor(public readonly tool: PixiGlobalEnvironment) {
        const hasExposed = tool.exposed && tool.exposed.length > 0;
        super(tool.name, hasExposed ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);

        const version = tool.dependencies?.[0]?.version;
        this.description = version ? `v${version}` : '';
        this.iconPath = new ThemeIcon('tools');
        this.contextValue = 'pixiGlobalTool';

        const lines = [`Tool: ${tool.name}`];
        if (version) {
            lines.push(`Version: ${version}`);
        }
        if (tool.dependencies && tool.dependencies.length > 1) {
            const extraDeps = tool.dependencies
                .slice(1)
                .map((d) => `${d.name} (${d.version})`)
                .join(', ');
            lines.push(`Extra dependencies: ${extraDeps}`);
        }
        if (hasExposed) {
            lines.push(`Exposed commands: ${tool.exposed!.map((e) => e.exposed_name).join(', ')}`);
        }
        this.tooltip = lines.join('\n');
    }
}

export class PixiGlobalBinaryTreeItem extends TreeItem {
    constructor(
        public readonly exposed: PixiGlobalExposed,
        public readonly tool: PixiGlobalEnvironment,
    ) {
        super(exposed.exposed_name, TreeItemCollapsibleState.None);
        this.description = `-> ${exposed.executable}`;
        this.iconPath = new ThemeIcon('terminal');
        this.contextValue = 'pixiGlobalBinary';
        this.tooltip = `Command: ${exposed.exposed_name}\nTarget: ${exposed.executable}\nProvided by tool: ${tool.name}`;
    }
}

export type PixiGlobalTreeItem = PixiGlobalToolTreeItem | PixiGlobalBinaryTreeItem;

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
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    public getTreeItem(element: PixiGlobalTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: PixiGlobalTreeItem): Promise<PixiGlobalTreeItem[]> {
        if (!element) {
            const tools = await listGlobalEnvironments();
            if (!tools || tools.length === 0) {
                return [];
            }
            return tools.map((tool) => new PixiGlobalToolTreeItem(tool));
        }

        if (element instanceof PixiGlobalToolTreeItem) {
            const exposed = element.tool.exposed;
            if (!exposed || exposed.length === 0) {
                return [];
            }
            return exposed.map((e) => new PixiGlobalBinaryTreeItem(e, element.tool));
        }

        return [];
    }
}
