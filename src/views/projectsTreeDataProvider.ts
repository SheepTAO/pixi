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
import { PixiEnvironmentInfo, PixiPackage, PixiProject } from '../core/types';

export class PixiProjectTreeItem extends TreeItem {
    constructor(public readonly project: PixiProject) {
        super(project.name, TreeItemCollapsibleState.Expanded);
        this.description = path.basename(project.manifestPath);
        this.tooltip = `Project: ${project.name}\nPath: ${project.projectPath}\nManifest: ${project.manifestPath}`;
        this.iconPath = new ThemeIcon('root-folder');
        this.contextValue = 'pixiProject';
    }
}

export class PixiPackageTreeItem extends TreeItem {
    constructor(
        public readonly pkg: PixiPackage,
        public readonly env: PixiEnvironmentInfo,
        public readonly project?: PixiProject,
    ) {
        super(pkg.name, TreeItemCollapsibleState.None);
        const versionStr = pkg.version ? ` v${pkg.version}` : '';
        this.description = pkg.version ? (pkg.kind === 'pypi' ? `${pkg.version} (pypi)` : pkg.version) : undefined;
        this.iconPath = pkg.is_explicit
            ? new ThemeIcon('package')
            : new ThemeIcon('symbol-field', new ThemeColor('descriptionForeground'));

        const lines = [
            `${pkg.name}${versionStr}`,
            `Kind: ${pkg.kind ? pkg.kind.toUpperCase() : 'Conda'}${pkg.is_explicit ? ' (explicit dependency)' : ' (transitive dependency)'}`,
        ];
        if (pkg.build) {
            lines.push(`Build: ${pkg.build}`);
        }
        if (pkg.license) {
            lines.push(`License: ${pkg.license}`);
        }
        if (pkg.source) {
            lines.push(`Source: ${pkg.source}`);
        }
        this.tooltip = lines.join('\n');
        this.contextValue = pkg.is_explicit ? 'pixiPackageExplicit' : 'pixiPackageTransitive';
    }
}

export class PixiEmptyTreeItem extends TreeItem {
    constructor(
        message: string,
        public readonly project?: PixiProject,
        public readonly env?: PixiEnvironmentInfo,
    ) {
        super(message, TreeItemCollapsibleState.None);
        this.iconPath = new ThemeIcon('info', new ThemeColor('descriptionForeground'));
        this.contextValue = 'pixiEmpty';
        if (env && project) {
            this.tooltip = `No packages found in '${env.pixiEnvName}'. Click to add a package.`;
            this.command = {
                command: 'pixi.addPackage',
                title: 'Add Package',
                arguments: [{ env, project }],
            };
        }
    }
}

export class PixiEnvironmentTreeItem extends TreeItem {
    constructor(
        public readonly env: PixiEnvironmentInfo,
        public readonly project: PixiProject,
    ) {
        const isInstalled = env.pixiStatus === 'installed';
        super(env.pixiEnvName, isInstalled ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);

        const details: string[] = [];
        if (env.toolchains?.python) {
            details.push(`Python ${env.toolchains.python.version || ''}`.trim());
        }

        if (isInstalled) {
            this.iconPath = new ThemeIcon('pass-filled', new ThemeColor('testing.iconPassed'));
            this.description = details.length > 0 ? details.join(', ') : undefined;
            this.contextValue = 'pixiEnvInstalled';
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

export type PixiProjectsTreeItem =
    | PixiProjectTreeItem
    | PixiEnvironmentTreeItem
    | PixiPackageTreeItem
    | PixiEmptyTreeItem;

export class PixiProjectsTreeDataProvider implements TreeDataProvider<PixiProjectsTreeItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiProjectsTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiProjectsTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];

    private treeView?: TreeView<PixiProjectsTreeItem>;

    constructor(private readonly projectManager: PixiProjectManager) {
        this.disposables.push(
            this.projectManager.onDidProjectsChanged(() => this.refresh()),
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
        );
    }

    public bindView(treeView: TreeView<PixiProjectsTreeItem>): void {
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
        this.projectManager.clearPackagesCache();
        this.updateViewDescription();
        this._onDidChangeTreeData.fire();
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    public getTreeItem(element: PixiProjectsTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: PixiProjectsTreeItem): Promise<PixiProjectsTreeItem[]> {
        const projects = this.projectManager.getProjects();

        if (!element) {
            if (projects.length === 0) {
                return [];
            }
            if (projects.length === 1) {
                const singleProject = projects[0];
                const envs = this.projectManager.getEnvironmentsForProject(singleProject.projectPath);
                return envs.map((e) => new PixiEnvironmentTreeItem(e, singleProject));
            }
            return projects.map((p) => new PixiProjectTreeItem(p));
        }

        if (element instanceof PixiProjectTreeItem) {
            const envs = this.projectManager.getEnvironmentsForProject(element.project.projectPath);
            return envs.map((e) => new PixiEnvironmentTreeItem(e, element.project));
        }

        if (element instanceof PixiEnvironmentTreeItem) {
            if (element.env.pixiStatus !== 'installed') {
                return [];
            }
            const packages = await this.projectManager.getPackagesForEnvironment(
                element.env.pixiEnvName,
                element.project.projectPath,
            );

            if (packages.length === 0) {
                return [new PixiEmptyTreeItem('No packages found', element.project, element.env)];
            }

            const sorted = [...packages].sort((a, b) => {
                if (a.is_explicit !== b.is_explicit) {
                    return a.is_explicit ? -1 : 1;
                }
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });

            return sorted.map((pkg) => new PixiPackageTreeItem(pkg, element.env, element.project));
        }

        return [];
    }
}
