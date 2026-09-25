import * as path from 'path';
import {
    Event,
    EventEmitter,
    ThemeColor,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
} from 'vscode';

import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo, PixiProject } from '../core/types';

export class PixiProjectTreeItem extends TreeItem {
    constructor(public readonly project: PixiProject) {
        super(project.name, TreeItemCollapsibleState.Expanded);
        this.description = path.basename(project.manifestPath);
        this.tooltip = `Project: ${project.name}\nPath: ${project.projectPath}\nManifest: ${project.manifestPath}`;
        this.iconPath = new ThemeIcon('root-folder');
        this.contextValue = 'pixiProject';
    }
}

export class PixiEnvironmentTreeItem extends TreeItem {
    constructor(
        public readonly env: PixiEnvironmentInfo,
        public readonly project: PixiProject,
    ) {
        super(env.pixiEnvName, TreeItemCollapsibleState.None);

        const details: string[] = [];
        if (env.toolchains?.python) {
            details.push(`Python ${env.toolchains.python.version || ''}`.trim());
        }

        if (env.pixiStatus === 'installed') {
            this.iconPath = new ThemeIcon('pass-filled', new ThemeColor('testing.iconPassed'));
            this.description = details.length > 0 ? details.join(', ') : undefined;
            this.contextValue = 'pixiEnvInstalled';
            this.command = {
                command: 'pixi.openTerminal',
                title: 'Open Terminal',
                arguments: [env],
            };
        } else if (env.pixiStatus === 'uninstalled') {
            this.iconPath = new ThemeIcon('circle-outline', new ThemeColor('disabledForeground'));
            this.description = '(not installed)';
            this.contextValue = 'pixiEnvUninstalled';
            this.command = {
                command: 'pixi.install',
                title: 'Install Environment',
                arguments: [Uri.file(project.projectPath), env.pixiEnvName],
            };
        } else {
            this.iconPath = new ThemeIcon('error', new ThemeColor('testing.iconFailed'));
            this.description = '(incompatible)';
            this.contextValue = 'pixiEnvIncompatible';
        }

        const lines = [
            `Environment: ${env.pixiEnvName}`,
            `Status: ${env.pixiStatus}`,
            `Project: ${project.name}`,
            `Prefix: ${env.prefix}`,
        ];
        if (env.statusReason) {
            lines.push(`Reason: ${env.statusReason}`);
        }
        if (env.toolchains?.python) {
            lines.push(`Python: ${env.toolchains.python.executable}`);
        }
        if (env.toolchains?.cpp?.compiler) {
            lines.push(`C/C++: ${env.toolchains.cpp.compiler}`);
        }
        if (env.platforms && env.platforms.length > 0) {
            const platformNames = env.platforms.map((p) => (typeof p === 'string' ? p : p.name));
            lines.push(`Platforms: ${platformNames.join(', ')}`);
        }
        this.tooltip = lines.join('\n');
    }
}

export type PixiProjectsTreeItem = PixiProjectTreeItem | PixiEnvironmentTreeItem;

export class PixiProjectsTreeDataProvider implements TreeDataProvider<PixiProjectsTreeItem> {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiProjectsTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiProjectsTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(private readonly projectManager: PixiProjectManager) {
        this.projectManager.onDidProjectsChanged(() => this.refresh());
        this.projectManager.onDidChangeEnvironments(() => this.refresh());
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: PixiProjectsTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: PixiProjectsTreeItem): Promise<PixiProjectsTreeItem[]> {
        if (!element) {
            const projects = this.projectManager.getProjects();
            return projects.map((p) => new PixiProjectTreeItem(p));
        }

        if (element instanceof PixiProjectTreeItem) {
            const envs = this.projectManager.getEnvironmentsForProject(element.project.projectPath);
            return envs.map((e) => new PixiEnvironmentTreeItem(e, element.project));
        }

        return [];
    }
}
