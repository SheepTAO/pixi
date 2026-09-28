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
    workspace,
} from 'vscode';

import { sortPixiEnvironments } from '../core/environmentRules';
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

export class PixiTransitiveGroupTreeItem extends TreeItem {
    constructor(
        public readonly packages: PixiPackage[],
        public readonly env: PixiEnvironmentInfo,
        public readonly project: PixiProject,
    ) {
        super('Transitive Dependencies', TreeItemCollapsibleState.Collapsed);
        this.description = `(${packages.length})`;
        const countText =
            packages.length === 1 ? '1 transitive dependency' : `${packages.length} transitive dependencies`;
        this.tooltip = `${countText} installed for '${env.pixiEnvName}'.\nClick to expand or collapse.`;
        this.iconPath = new ThemeIcon('references', new ThemeColor('descriptionForeground'));
        this.contextValue = 'pixiTransitiveGroup';
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

        if (pkg.is_editable || pkg.is_local) {
            const tag = pkg.is_editable ? 'editable' : 'local';
            this.description = pkg.version ? `${pkg.version} (${tag})` : `(${tag})`;
            this.iconPath = new ThemeIcon('folder-library', new ThemeColor('charts.blue'));
        } else {
            this.description = pkg.version ? (pkg.kind === 'pypi' ? `${pkg.version} (pypi)` : pkg.version) : undefined;
            this.iconPath = pkg.is_explicit
                ? new ThemeIcon('package')
                : new ThemeIcon('symbol-field', new ThemeColor('descriptionForeground'));
        }

        const lines = [
            `${pkg.name}${versionStr}`,
            `Kind: ${pkg.kind ? pkg.kind.toUpperCase() : 'Conda'}${pkg.is_explicit ? ' (explicit dependency)' : ' (transitive dependency)'}`,
        ];
        if (pkg.is_editable || pkg.is_local) {
            lines.push(`Type: Local ${pkg.is_editable ? 'Editable ' : ''}Subpackage`);
        }
        if (pkg.local_path) {
            lines.push(`Path: ${pkg.local_path}`);
        }
        if (pkg.build) {
            lines.push(`Build: ${pkg.build}`);
        }
        if (pkg.license) {
            lines.push(`License: ${pkg.license}`);
        }
        if (pkg.source && !pkg.is_local) {
            lines.push(`Source: ${pkg.source}`);
        }
        if (pkg.local_manifest_path) {
            lines.push(`\nClick to open ${path.basename(pkg.local_manifest_path)}`);
            this.command = {
                command: 'vscode.open',
                title: 'Open Subpackage Manifest',
                arguments: [Uri.file(pkg.local_manifest_path)],
            };
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

        const toolchains: { label: string; shortName: string }[] = [];
        if (env.toolchains?.python) {
            const v = env.toolchains.python.version;
            toolchains.push({
                label: v ? `Python ${v}` : 'Python',
                shortName: 'Python',
            });
        }
        if (env.toolchains?.cpp?.compiler) {
            const cpp = env.toolchains.cpp;
            const compilerName =
                cpp.compilerType === 'gcc'
                    ? 'GCC'
                    : cpp.compilerType === 'clang'
                      ? 'Clang'
                      : cpp.compilerType === 'msvc'
                        ? 'MSVC'
                        : 'C++';
            const label = cpp.version ? `${compilerName} ${cpp.version}` : cpp.compilerType ? compilerName : 'C++';
            toolchains.push({
                label,
                shortName: 'C++',
            });
        }
        if (env.toolchains?.rust?.rustc) {
            const v = env.toolchains.rust.version;
            toolchains.push({
                label: v ? `Rust ${v}` : 'Rust',
                shortName: 'Rust',
            });
        }
        if (env.toolchains?.r?.executable) {
            const v = env.toolchains.r.version;
            toolchains.push({
                label: v ? `R ${v}` : 'R',
                shortName: 'R',
            });
        }

        if (isInstalled) {
            this.iconPath = new ThemeIcon('pass-filled', new ThemeColor('testing.iconPassed'));
            if (toolchains.length > 0) {
                this.description =
                    toolchains.length <= 2
                        ? toolchains.map((t) => t.label).join(', ')
                        : toolchains.map((t) => t.shortName).join(', ');
            } else {
                this.description = undefined;
            }
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
            const py = env.toolchains.python;
            lines.push(py.version ? `Python: ${py.version} (${py.executable})` : `Python: ${py.executable}`);
        }
        if (env.toolchains?.cpp?.compiler) {
            const cpp = env.toolchains.cpp;
            const cppLabel =
                cpp.compilerType === 'gcc'
                    ? 'GCC'
                    : cpp.compilerType === 'clang'
                      ? 'Clang'
                      : cpp.compilerType === 'msvc'
                        ? 'MSVC'
                        : 'C/C++';
            lines.push(
                cpp.version ? `C/C++ (${cppLabel}): ${cpp.version} (${cpp.compiler})` : `C/C++: ${cpp.compiler}`,
            );
        }
        if (env.toolchains?.cpp?.cmake) {
            lines.push(`CMake: ${env.toolchains.cpp.cmake}`);
        }
        if (env.toolchains?.cpp?.ninja) {
            lines.push(`Ninja: ${env.toolchains.cpp.ninja}`);
        }
        if (env.toolchains?.rust?.rustc) {
            const rust = env.toolchains.rust;
            lines.push(rust.version ? `Rust: ${rust.version} (${rust.rustc})` : `Rust: ${rust.rustc}`);
        }
        if (env.toolchains?.rust?.cargo) {
            lines.push(`Cargo: ${env.toolchains.rust.cargo}`);
        }
        if (env.toolchains?.r?.executable) {
            const r = env.toolchains.r;
            lines.push(r.version ? `R: ${r.version} (${r.executable})` : `R: ${r.executable}`);
        }
        if (env.toolchains?.r?.rscript) {
            lines.push(`Rscript: ${env.toolchains.r.rscript}`);
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
    | PixiEmptyTreeItem
    | PixiTransitiveGroupTreeItem;

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
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.packages.displayMode')) {
                    this._onDidChangeTreeData.fire();
                }
            }),
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

    private sortEnvironments(envs: PixiEnvironmentInfo[]): PixiEnvironmentInfo[] {
        return sortPixiEnvironments(envs);
    }

    public async getChildren(element?: PixiProjectsTreeItem): Promise<PixiProjectsTreeItem[]> {
        const projects = this.projectManager.getProjects();

        if (!element) {
            if (projects.length === 0) {
                return [];
            }
            if (projects.length === 1) {
                const singleProject = projects[0];
                const envs = this.sortEnvironments(
                    this.projectManager.getEnvironmentsForProject(singleProject.projectPath),
                );
                return envs.map((e) => new PixiEnvironmentTreeItem(e, singleProject));
            }
            return projects.map((p) => new PixiProjectTreeItem(p));
        }

        if (element instanceof PixiProjectTreeItem) {
            const envs = this.sortEnvironments(
                this.projectManager.getEnvironmentsForProject(element.project.projectPath),
            );
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

            const config = workspace.getConfiguration('pixi', Uri.file(element.project.projectPath));
            const displayMode = config.get<'grouped' | 'explicitOnly' | 'all'>('packages.displayMode', 'grouped');

            const explicit = packages.filter((p) => p.is_explicit);
            const transitive = packages.filter((p) => !p.is_explicit);

            explicit.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            transitive.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

            if (displayMode === 'explicitOnly') {
                if (explicit.length === 0) {
                    return [new PixiEmptyTreeItem('No explicit packages found', element.project, element.env)];
                }
                return explicit.map((pkg) => new PixiPackageTreeItem(pkg, element.env, element.project));
            }

            if (displayMode === 'all') {
                return [...explicit, ...transitive].map(
                    (pkg) => new PixiPackageTreeItem(pkg, element.env, element.project),
                );
            }

            // 'grouped' mode (default)
            const result: PixiProjectsTreeItem[] = explicit.map(
                (pkg) => new PixiPackageTreeItem(pkg, element.env, element.project),
            );
            if (transitive.length > 0) {
                result.push(new PixiTransitiveGroupTreeItem(transitive, element.env, element.project));
            }
            if (result.length === 0) {
                return [new PixiEmptyTreeItem('No packages found', element.project, element.env)];
            }
            return result;
        }

        if (element instanceof PixiTransitiveGroupTreeItem) {
            return element.packages.map((pkg) => new PixiPackageTreeItem(pkg, element.env, element.project));
        }

        return [];
    }
}
