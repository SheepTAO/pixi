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

import { getWorkspaceEnvironments, getWorkspaceFeatures, WorkspaceListEntry } from '../commands/workspace/common';
import { normalizePkgName, sortPixiPackages } from '../core/packageManager';
import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo, PixiPackage, PixiProject } from '../core/types';

export class PixiProjectTreeItem extends TreeItem {
    get projectPath(): string {
        return this.project.projectPath;
    }
    get manifestPath(): string {
        return this.project.manifestPath;
    }

    constructor(public readonly project: PixiProject) {
        super(project.name, TreeItemCollapsibleState.Expanded);
        this.description = path.basename(project.manifestPath);
        this.tooltip = `Project: ${project.name}\nPath: ${project.projectPath}\nManifest: ${project.manifestPath}`;
        this.iconPath = new ThemeIcon('root-folder');
        this.contextValue = 'pixiProject';
    }
}

export class PixiTransitiveGroupTreeItem extends TreeItem {
    get projectPath(): string {
        return this.project.projectPath;
    }
    get manifestPath(): string {
        return this.project.manifestPath;
    }
    get pixiEnvName(): string {
        return this.env.pixiEnvName;
    }

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
    get projectPath(): string {
        return this.project?.projectPath || this.env.projectPath;
    }
    get manifestPath(): string {
        return this.project?.manifestPath || path.join(this.env.projectPath, 'pixi.toml');
    }
    get pixiEnvName(): string {
        return this.env.pixiEnvName;
    }
    get featureName(): string | undefined {
        return this._featureName;
    }
    get name(): string {
        return this.pkg.name;
    }

    constructor(
        public readonly pkg: PixiPackage,
        public readonly env: PixiEnvironmentInfo,
        public readonly project?: PixiProject,
        private readonly _featureName?: string,
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
        if (this._featureName) {
            lines.push(`Feature: ${this._featureName}`);
        }
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
    get projectPath(): string | undefined {
        return this.project?.projectPath || this.env?.projectPath;
    }
    get manifestPath(): string | undefined {
        return this.project?.manifestPath;
    }
    get pixiEnvName(): string | undefined {
        return this.env?.pixiEnvName;
    }

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
    get projectPath(): string {
        return this.project.projectPath;
    }
    get manifestPath(): string {
        return this.project.manifestPath;
    }
    get pixiEnvName(): string {
        return this.env.pixiEnvName;
    }

    constructor(
        public readonly env: PixiEnvironmentInfo,
        public readonly project: PixiProject,
        public readonly envFeatures?: string[],
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
        let cppCompilerLabel: string | undefined;
        if (env.toolchains?.cpp?.compiler) {
            const cpp = env.toolchains.cpp;
            cppCompilerLabel =
                cpp.compilerType === 'gcc'
                    ? 'GCC'
                    : cpp.compilerType === 'clang'
                      ? 'Clang'
                      : cpp.compilerType === 'msvc'
                        ? 'MSVC'
                        : 'C++';
            const label = cpp.version ? `${cppCompilerLabel} ${cpp.version}` : cppCompilerLabel;
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
                command: 'pixi.installEnvironment',
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
        if (envFeatures && envFeatures.length > 0) {
            lines.push(`Features: ${envFeatures.join(', ')}`);
        }
        if (env.statusReason) {
            lines.push(`Reason: ${env.statusReason}`);
        }
        if (env.toolchains?.python) {
            const py = env.toolchains.python;
            lines.push(py.version ? `Python: ${py.version} (${py.executable})` : `Python: ${py.executable}`);
        }
        if (env.toolchains?.cpp?.compiler) {
            const cpp = env.toolchains.cpp;
            lines.push(
                cpp.version
                    ? `C/C++ (${cppCompilerLabel}): ${cpp.version} (${cpp.compiler})`
                    : `C/C++: ${cpp.compiler}`,
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

export class PixiFeatureTreeItem extends TreeItem {
    get projectPath(): string {
        return this.project.projectPath;
    }
    get manifestPath(): string {
        return this.project.manifestPath;
    }
    get featureName(): string {
        return this.feature.name;
    }

    constructor(
        public readonly feature: WorkspaceListEntry,
        public readonly project: PixiProject,
        public readonly usedByEnvs: string[],
    ) {
        const totalDeps = feature.dependencies.length + feature.pypiDependencies.length;
        super(feature.name, totalDeps > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);

        const isDefault = feature.name === 'default';
        this.iconPath = new ThemeIcon('symbol-namespace');

        if (isDefault) {
            this.description = '(Global)';
            this.contextValue = 'pixiFeatureDefault';
        } else {
            this.description = usedByEnvs.length > 0 ? `Used by: ${usedByEnvs.join(', ')}` : '(Unused)';
            this.contextValue = 'pixiFeatureItem';
        }

        const lines = [
            `Feature: ${feature.name}`,
            `Project: ${project.name}`,
            isDefault
                ? 'Scope: Global (available to all environments)'
                : `Used by: ${usedByEnvs.length > 0 ? usedByEnvs.join(', ') : 'None'}`,
            `Conda Dependencies: ${feature.dependencies.length}`,
            `PyPI Dependencies: ${feature.pypiDependencies.length}`,
        ];
        this.tooltip = lines.join('\n');
    }
}

export class PixiDeclaredPackageTreeItem extends TreeItem {
    get projectPath(): string {
        return this.project.projectPath;
    }
    get manifestPath(): string {
        return this.project.manifestPath;
    }
    get name(): string {
        return this.pkgName;
    }
    get featureName(): string {
        return this.feature.name;
    }
    get pkg(): { name: string; kind: 'conda' | 'pypi' } {
        return { name: this.pkgName, kind: this.kind };
    }

    constructor(
        public readonly pkgName: string,
        public readonly kind: 'conda' | 'pypi',
        public readonly feature: WorkspaceListEntry,
        public readonly project: PixiProject,
    ) {
        super(pkgName, TreeItemCollapsibleState.None);
        this.description = kind === 'pypi' ? 'pypi' : 'conda';
        this.iconPath =
            kind === 'pypi' ? new ThemeIcon('symbol-keyword', new ThemeColor('charts.blue')) : new ThemeIcon('package');
        this.contextValue = 'pixiDeclaredPackage';
        this.tooltip = `${pkgName}\nSource: ${kind.toUpperCase()}\nDeclared in feature: ${feature.name}\nProject: ${project.name}`;
    }
}

export class PixiEnvFeatureGroupTreeItem extends TreeItem {
    get projectPath(): string {
        return this.project.projectPath;
    }
    get manifestPath(): string {
        return this.project.manifestPath;
    }
    get envName(): string {
        return this.env.pixiEnvName;
    }
    get featureName(): string {
        return this.groupName;
    }
    get feature(): { name: string } {
        return { name: this.groupName };
    }

    constructor(
        public readonly groupName: string,
        public readonly packages: PixiPackage[],
        public readonly env: PixiEnvironmentInfo,
        public readonly project: PixiProject,
        public readonly isDefault: boolean = false,
    ) {
        super(groupName, packages.length > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None);
        this.description = `(${packages.length})`;
        this.iconPath = new ThemeIcon('symbol-namespace');
        this.tooltip = isDefault
            ? `Global Feature '${groupName}': ${packages.length} package(s) in environment '${env.pixiEnvName}'`
            : `Feature '${groupName}': ${packages.length} package(s) in environment '${env.pixiEnvName}'`;
        this.contextValue = isDefault ? 'pixiEnvFeatureDefault' : 'pixiEnvFeatureGroup';
    }
}

export type ProjectsViewMode = 'environment' | 'feature';

export type PixiProjectsTreeItem =
    | PixiProjectTreeItem
    | PixiEnvironmentTreeItem
    | PixiEnvFeatureGroupTreeItem
    | PixiPackageTreeItem
    | PixiEmptyTreeItem
    | PixiTransitiveGroupTreeItem
    | PixiFeatureTreeItem
    | PixiDeclaredPackageTreeItem;

export class PixiProjectsTreeDataProvider implements TreeDataProvider<PixiProjectsTreeItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiProjectsTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiProjectsTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];

    private treeView?: TreeView<PixiProjectsTreeItem>;
    private currentViewMode: ProjectsViewMode = 'environment';

    constructor(private readonly projectManager: PixiProjectManager) {
        const config = workspace.getConfiguration('pixi.environments');
        this.currentViewMode = config.get<ProjectsViewMode>('viewMode', 'environment');

        this.disposables.push(
            this.projectManager.onDidProjectsChanged(() => this.refresh()),
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.packages.displayMode')) {
                    this._onDidChangeTreeData.fire();
                }
                if (e.affectsConfiguration('pixi.environments.viewMode')) {
                    const newMode = workspace
                        .getConfiguration('pixi.environments')
                        .get<ProjectsViewMode>('viewMode', 'environment');
                    if (newMode !== this.currentViewMode) {
                        this.currentViewMode = newMode;
                        this.refresh();
                    }
                }
            }),
        );
    }

    public getViewMode(): ProjectsViewMode {
        return this.currentViewMode;
    }

    public bindView(treeView: TreeView<PixiProjectsTreeItem>): void {
        this.treeView = treeView;
        this.updateViewDescription();
    }

    public refresh(): void {
        this.projectManager.clearPackagesCache();
        this.updateViewDescription();
        this._onDidChangeTreeData.fire();
    }

    private updateViewDescription(): void {
        if (this.treeView) {
            this.treeView.description = this.currentViewMode === 'feature' ? 'features' : undefined;
        }
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

    private async getFeatureItemsForProject(project: PixiProject): Promise<PixiProjectsTreeItem[]> {
        const [features, envs] = await Promise.all([
            getWorkspaceFeatures(project.projectPath),
            getWorkspaceEnvironments(project.projectPath),
        ]);
        if (features.length === 0) {
            return [new PixiEmptyTreeItem('No features declared in project', project)];
        }
        return features.map((f) => {
            const usedByEnvs = envs.filter((e) => e.features && e.features.includes(f.name)).map((e) => e.name);
            return new PixiFeatureTreeItem(f, project, usedByEnvs);
        });
    }

    private async getEnvironmentItemsForProject(project: PixiProject): Promise<PixiProjectsTreeItem[]> {
        const envs = this.projectManager.getEnvironmentsForProject(project.projectPath);
        const wsEnvs = await getWorkspaceEnvironments(project.projectPath);
        const envFeaturesMap = new Map<string, string[]>();
        for (const we of wsEnvs) {
            if (we.features) {
                envFeaturesMap.set(we.name, we.features);
            }
        }
        return envs.map((e) => new PixiEnvironmentTreeItem(e, project, envFeaturesMap.get(e.pixiEnvName)));
    }

    public async getChildren(element?: PixiProjectsTreeItem): Promise<PixiProjectsTreeItem[]> {
        const projects = this.projectManager.getProjects();

        if (!element) {
            if (projects.length === 0) {
                return [];
            }
            if (projects.length === 1) {
                const singleProject = projects[0];
                return this.currentViewMode === 'feature'
                    ? this.getFeatureItemsForProject(singleProject)
                    : this.getEnvironmentItemsForProject(singleProject);
            }
            return projects.map((p) => new PixiProjectTreeItem(p));
        }

        if (element instanceof PixiProjectTreeItem) {
            return this.currentViewMode === 'feature'
                ? this.getFeatureItemsForProject(element.project)
                : this.getEnvironmentItemsForProject(element.project);
        }

        if (element instanceof PixiFeatureTreeItem) {
            const items: PixiProjectsTreeItem[] = [];
            for (const dep of element.feature.dependencies) {
                items.push(new PixiDeclaredPackageTreeItem(dep, 'conda', element.feature, element.project));
            }
            for (const dep of element.feature.pypiDependencies) {
                items.push(new PixiDeclaredPackageTreeItem(dep, 'pypi', element.feature, element.project));
            }
            if (items.length === 0) {
                items.push(new PixiEmptyTreeItem('No dependencies declared in this feature', element.project));
            }
            return items;
        }

        if (element instanceof PixiEnvFeatureGroupTreeItem) {
            if (element.packages.length === 0) {
                return [new PixiEmptyTreeItem('No packages found in this feature', element.project, element.env)];
            }
            return element.packages.map(
                (pkg) => new PixiPackageTreeItem(pkg, element.env, element.project, element.groupName),
            );
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

            const allFeatures = await getWorkspaceFeatures(element.project.projectPath);
            const hasCustomFeatures = allFeatures.some((f) => f.name !== 'default');
            const sorted = sortPixiPackages(packages);

            if (!hasCustomFeatures) {
                if (displayMode === 'all') {
                    return sorted.map((pkg) => new PixiPackageTreeItem(pkg, element.env, element.project));
                }

                const explicit = sorted.filter((p) => p.is_explicit);
                if (displayMode === 'explicitOnly') {
                    if (explicit.length === 0) {
                        return [new PixiEmptyTreeItem('No explicit packages found', element.project, element.env)];
                    }
                    return explicit.map((pkg) => new PixiPackageTreeItem(pkg, element.env, element.project));
                }

                // 'grouped' mode (default)
                const transitive = sorted.filter((p) => !p.is_explicit);
                const result: PixiProjectsTreeItem[] = explicit.map(
                    (pkg) => new PixiPackageTreeItem(pkg, element.env, element.project),
                );
                if (transitive.length > 0) {
                    result.push(new PixiTransitiveGroupTreeItem(transitive, element.env, element.project));
                }
                return result;
            }

            // Project has custom features: group explicit dependencies by their declared feature
            const envFeatureNames = new Set(element.envFeatures ?? []);
            const defaultFeature = allFeatures.find((f) => f.name === 'default');
            if (
                defaultFeature &&
                (defaultFeature.dependencies.length > 0 || defaultFeature.pypiDependencies.length > 0)
            ) {
                envFeatureNames.add('default');
            }

            const targetFeatures = allFeatures.filter((f) => envFeatureNames.has(f.name));
            const matchedPackages = new Set<PixiPackage>();
            const featureItems: PixiProjectsTreeItem[] = [];

            for (const f of targetFeatures) {
                const declaredNames = new Set<string>([
                    ...f.dependencies.map((d) => normalizePkgName(d)),
                    ...f.pypiDependencies.map((d) => normalizePkgName(d)),
                ]);

                const featurePkgs = sorted.filter((pkg) => declaredNames.has(normalizePkgName(pkg.name)));
                for (const p of featurePkgs) {
                    matchedPackages.add(p);
                }

                if (f.dependencies.length > 0 || f.pypiDependencies.length > 0) {
                    featureItems.push(
                        new PixiEnvFeatureGroupTreeItem(
                            f.name,
                            featurePkgs,
                            element.env,
                            element.project,
                            f.name === 'default',
                        ),
                    );
                }
            }

            const transitive = sorted.filter((pkg) => !matchedPackages.has(pkg));
            if (displayMode !== 'explicitOnly' && transitive.length > 0) {
                featureItems.push(new PixiTransitiveGroupTreeItem(transitive, element.env, element.project));
            }

            if (featureItems.length === 0) {
                return [new PixiEmptyTreeItem('No packages found', element.project, element.env)];
            }

            return featureItems;
        }

        if (element instanceof PixiTransitiveGroupTreeItem) {
            return element.packages.map((pkg) => new PixiPackageTreeItem(pkg, element.env, element.project));
        }

        return [];
    }
}
