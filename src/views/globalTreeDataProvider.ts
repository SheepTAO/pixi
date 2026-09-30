import {
    Disposable,
    Event,
    EventEmitter,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
} from 'vscode';

import { listGlobalEnvironments, onDidChangeGlobalEnvironments, PixiGlobalEnvironment } from '../cli/globalCli';

export class PixiGlobalToolTreeItem extends TreeItem {
    constructor(public readonly tool: PixiGlobalEnvironment) {
        super(tool.name, TreeItemCollapsibleState.None);

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
        if (tool.exposed?.length) {
            lines.push(`Exposed commands: ${tool.exposed.map((e) => e.exposed_name).join(', ')}`);
        }
        this.tooltip = lines.join('\n');
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
            return tools?.map((tool) => new PixiGlobalToolTreeItem(tool)) ?? [];
        }

        return [];
    }
}
