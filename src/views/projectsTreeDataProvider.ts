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

import { getReferencingEnvs, getWorkspaceFeatures, WorkspaceListEntry } from '../commands/workspace/common';
import { enrichLocalPackages, normalizePkgName, sortPixiPackages, splitPackageSpec } from '../core/packageManager';
import { getProjectKey } from '../core/projectDiscovery';
import { PixiProjectManager } from '../core/projectManager';
import {
    formatSystemRequirementsSummary,
    getProjectSystemRequirements,
    SYSTEM_REQUIREMENT_DESCRIPTORS,
    SystemRequirementsRecord,
} from '../core/systemRequirements';
import { formatToolchainDetails, formatToolchainSummary } from '../core/toolchains';
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
        public readonly env: PixiEnvironmentInfo | undefined,
        public readonly project: PixiProject,
        public readonly featureName?: string,
    ) {
        super(pkg.name, TreeItemCollapsibleState.None);
        const versionStr = pkg.version ? ` v${pkg.version}` : '';

        if (pkg.is_editable || pkg.is_local) {
            const tag = pkg.is_editable ? 'editable' : 'local';
            this.description = pkg.version ? `${pkg.version} (${tag})` : `(${tag})`;
            this.iconPath = new ThemeIcon('folder-library', new ThemeColor('charts.blue'));
        } else {
            this.description = pkg.version
                ? pkg.kind === 'pypi'
                    ? `${pkg.version} (pypi)`
                    : pkg.version
                : pkg.kind === 'pypi'
                  ? '(pypi)'
                  : undefined;
            this.iconPath = pkg.is_explicit
                ? new ThemeIcon('package')
                : new ThemeIcon('symbol-field', new ThemeColor('descriptionForeground'));
        }

        const lines = [
            `${pkg.name}${versionStr}`,
            `Kind: ${pkg.kind ? pkg.kind.toUpperCase() : 'Conda'}${pkg.is_explicit ? ' (explicit dependency)' : ' (transitive dependency)'}`,
        ];
        if (this.featureName) {
            lines.push(`Feature: ${this.featureName}`);
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
        const isLocal = Boolean(pkg.is_editable || pkg.is_local);
        this.contextValue = isLocal
            ? pkg.is_explicit
                ? 'pixiPackageLocalExplicit'
                : 'pixiPackageLocalTransitive'
            : pkg.is_explicit
              ? 'pixiPackageExplicit'
              : 'pixiPackageTransitive';
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
        public readonly envFeatures?: string[],
    ) {
        const isInstalled = env.pixiStatus === 'installed';
        super(env.pixiEnvName, isInstalled ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);

        const toolchainSummary = formatToolchainSummary(env.toolchains);
        const toolchainLines = formatToolchainDetails(env.toolchains);

        if (isInstalled) {
            this.iconPath = new ThemeIcon('pass-filled', new ThemeColor('testing.iconPassed'));
            const descParts: string[] = [];
            if (toolchainSummary) {
                descParts.push(toolchainSummary);
            }
            if (env.solveGroup) {
                descParts.push(`[${env.solveGroup}]`);
            }
            this.description = descParts.join(' ') || undefined;
            this.contextValue = 'pixiEnvInstalled';
        } else if (env.pixiStatus === 'uninstalled') {
            this.iconPath = new ThemeIcon('circle-outline', new ThemeColor('disabledForeground'));
            this.description = env.solveGroup ? `(not installed) [${env.solveGroup}]` : '(not installed)';
            this.contextValue = 'pixiEnvUninstalled';
            this.command = {
                command: 'pixi.installEnvironment',
                title: 'Install Environment',
                arguments: [Uri.file(project.projectPath), env.pixiEnvName],
            };
        } else {
            this.iconPath = new ThemeIcon('error', new ThemeColor('testing.iconFailed'));
            this.description = env.solveGroup ? `(incompatible) [${env.solveGroup}]` : '(incompatible)';
            this.contextValue = 'pixiEnvIncompatible';
        }

        const lines = [
            `Environment: ${env.pixiEnvName}`,
            `Status: ${env.pixiStatus}`,
            `Project: ${project.name}`,
            `Prefix: ${env.prefix}`,
        ];
        if (env.solveGroup) {
            lines.push(`Solve Group: ${env.solveGroup}`);
        }
        if (env.environmentSize) {
            lines.push(`Size on Disk: ${env.environmentSize}`);
        }
        if (envFeatures && envFeatures.length > 0) {
            lines.push(`Features: ${envFeatures.join(', ')}`);
        }
        if (env.statusReason) {
            lines.push(`Reason: ${env.statusReason}`);
        }
        lines.push(...toolchainLines);
        if (env.resolvedPlatform) {
            lines.push(`Resolved Platform: ${env.resolvedPlatform}`);
        }
        if (env.platforms && env.platforms.length > 0) {
            const platformNames = env.platforms.map((p) => (typeof p === 'string' ? p : p.name));
            lines.push(`Configured Platforms: ${platformNames.join(', ')}`);
        }
        this.tooltip = lines.join('\n');
    }
}

export class PixiFeatureTreeItem extends TreeItem {
    constructor(
        public readonly feature: WorkspaceListEntry,
        public readonly project: PixiProject,
        public readonly env?: PixiEnvironmentInfo,
        public readonly packages?: PixiPackage[],
        public readonly usedByEnvs: string[] = [],
    ) {
        const isDefault = feature.name === 'default';
        const isEnvScoped = packages !== undefined && env !== undefined;
        const totalDeps = packages ? packages.length : feature.dependencies.length + feature.pypiDependencies.length;
        super(
            feature.name,
            totalDeps === 0
                ? TreeItemCollapsibleState.None
                : isEnvScoped
                  ? TreeItemCollapsibleState.Expanded
                  : TreeItemCollapsibleState.Collapsed,
        );

        this.iconPath = new ThemeIcon('symbol-namespace');
        this.contextValue = isDefault ? 'pixiFeatureDefault' : 'pixiFeatureItem';

        if (isEnvScoped) {
            this.description = `(${packages.length})`;
            this.tooltip = isDefault
                ? `Global Feature '${feature.name}': ${packages.length} package(s) in environment '${env.pixiEnvName}'`
                : `Feature '${feature.name}': ${packages.length} package(s) in environment '${env.pixiEnvName}'`;
        } else {
            this.description = isDefault
                ? '(Global)'
                : usedByEnvs.length > 0
                  ? `Used by: ${usedByEnvs.join(', ')}`
                  : '(Unused)';
            const tooltipLines = [
                `Feature: ${feature.name}`,
                `Project: ${project.name}`,
                isDefault
                    ? 'Scope: Global (available to all environments)'
                    : `Used by: ${usedByEnvs.length > 0 ? usedByEnvs.join(', ') : 'None'}`,
                `Conda Dependencies: ${feature.dependencies.length}`,
                `PyPI Dependencies: ${feature.pypiDependencies.length}`,
            ];
            if (feature.tasks && feature.tasks.length > 0) {
                tooltipLines.push(`Tasks: ${feature.tasks.join(', ')}`);
            }
            this.tooltip = tooltipLines.join('\n');
        }
    }
}

export class PixiSystemRequirementsTreeItem extends TreeItem {
    constructor(
        public readonly project: PixiProject,
        public readonly requirements: SystemRequirementsRecord,
    ) {
        super('System Requirements', TreeItemCollapsibleState.Collapsed);
        this.iconPath = new ThemeIcon('server-process');
        this.contextValue = 'pixiSystemRequirements';
        this.description = formatSystemRequirementsSummary(requirements);
        const lines = [
            `System Requirements: ${project.name}`,
            ...Object.entries(requirements).map(([k, v]) => `  ${k}: ${v}`),
            'Expand to view properties, or click inline actions to reveal/configure in manifest',
        ];
        this.tooltip = lines.join('\n');
    }
}

export class PixiSystemRequirementPropertyTreeItem extends TreeItem {
    constructor(
        public readonly propertyName: string,
        public readonly propertyValue: string,
        public readonly project: PixiProject,
    ) {
        super(propertyName, TreeItemCollapsibleState.None);
        const descriptor = SYSTEM_REQUIREMENT_DESCRIPTORS.find((d) => d.id === propertyName);
        this.iconPath = new ThemeIcon(descriptor?.icon || 'symbol-property');
        this.contextValue = 'pixiSystemRequirementProperty';
        this.description = propertyValue;
        this.tooltip = `${propertyName} = "${propertyValue}"\nClick to edit requirement`;
        this.command = {
            command: 'pixi.systemRequirements.editProperty',
            title: 'Edit Requirement',
            arguments: [project.projectPath, propertyName],
        };
    }
}

export type ProjectsViewMode = 'environment' | 'feature';

export type PixiProjectsTreeItem =
    | PixiProjectTreeItem
    | PixiEnvironmentTreeItem
    | PixiFeatureTreeItem
    | PixiPackageTreeItem
    | PixiEmptyTreeItem
    | PixiTransitiveGroupTreeItem
    | PixiSystemRequirementsTreeItem
    | PixiSystemRequirementPropertyTreeItem;

export class PixiProjectsTreeDataProvider implements TreeDataProvider<PixiProjectsTreeItem>, Disposable {
    private readonly _onDidChangeTreeData = new EventEmitter<PixiProjectsTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: Event<PixiProjectsTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;
    private readonly disposables: Disposable[] = [];

    private treeView?: TreeView<PixiProjectsTreeItem>;
    private currentViewMode: ProjectsViewMode = 'environment';
    private readonly featuresCache = new Map<string, Promise<WorkspaceListEntry[]>>();

    constructor(private readonly projectManager: PixiProjectManager) {
        const config = workspace.getConfiguration('pixi.environments');
        this.currentViewMode = config.get<ProjectsViewMode>('viewMode', 'environment');

        this.disposables.push(
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.packages.displayMode')) {
                    this._onDidChangeTreeData.fire();
                }
                if (
                    e.affectsConfiguration('pixi.environments.viewMode') ||
                    e.affectsConfiguration('pixi.environments.systemRequirementsPosition')
                ) {
                    const newMode = workspace
                        .getConfiguration('pixi.environments')
                        .get<ProjectsViewMode>('viewMode', 'environment');
                    if (newMode !== this.currentViewMode) {
                        this.currentViewMode = newMode;
                    }
                    this.refresh();
                }
            }),
        );
    }

    public bindView(treeView: TreeView<PixiProjectsTreeItem>): void {
        this.treeView = treeView;
        this.updateViewDescription();
    }

    public refresh(): void {
        this.featuresCache.clear();
        this.updateViewDescription();
        this._onDidChangeTreeData.fire();
    }

    private updateViewDescription(): void {
        if (this.treeView) {
            this.treeView.description = this.currentViewMode === 'feature' ? 'features' : undefined;
        }
    }

    public dispose(): void {
        this.featuresCache.clear();
        this._onDidChangeTreeData.dispose();
        Disposable.from(...this.disposables).dispose();
    }

    public getTreeItem(element: PixiProjectsTreeItem): TreeItem {
        return element;
    }

    private getProjectFeatures(projectPath: string): Promise<WorkspaceListEntry[]> {
        const key = getProjectKey(projectPath);
        let promise = this.featuresCache.get(key);
        if (!promise) {
            promise = getWorkspaceFeatures(projectPath);
            this.featuresCache.set(key, promise);
        }
        return promise;
    }

    private matchFeaturePackages(feature: WorkspaceListEntry, sortedPackages: PixiPackage[]): PixiPackage[] {
        const declaredNames = new Set<string>([
            ...feature.dependencies.map((d) => normalizePkgName(d)),
            ...feature.pypiDependencies.map((d) => normalizePkgName(d)),
        ]);
        return sortedPackages.filter((pkg) => declaredNames.has(normalizePkgName(pkg.name)));
    }

    private async resolvePackagesForFeature(
        feature: WorkspaceListEntry,
        project: PixiProject,
        env?: PixiEnvironmentInfo,
    ): Promise<PixiPackage[]> {
        const installed = env
            ? await this.projectManager.getPackagesForEnvironment(env.pixiEnvName, project.projectPath)
            : [];
        const matched = this.matchFeaturePackages(feature, installed);
        const matchedNames = new Set(matched.map((p) => normalizePkgName(p.name)));

        const fallbackSpecs: Array<{ rawSpec: string; kind: 'conda' | 'pypi' }> = [
            ...feature.dependencies.map((rawSpec) => ({ rawSpec, kind: 'conda' as const })),
            ...feature.pypiDependencies.map((rawSpec) => ({ rawSpec, kind: 'pypi' as const })),
        ];

        const fallbacks: PixiPackage[] = [];
        for (const { rawSpec, kind } of fallbackSpecs) {
            const { name: pkgName, constraint } = splitPackageSpec(rawSpec);
            if (!matchedNames.has(normalizePkgName(pkgName))) {
                fallbacks.push({
                    name: pkgName,
                    version: constraint && constraint !== '*' ? constraint : '',
                    kind,
                    is_explicit: true,
                    requested_spec: rawSpec,
                });
            }
        }

        if (fallbacks.length > 0) {
            await enrichLocalPackages(fallbacks, project.projectPath);
        }

        return sortPixiPackages([...matched, ...fallbacks]);
    }

    private async getFeatureItemsForProject(project: PixiProject): Promise<PixiProjectsTreeItem[]> {
        const features = await this.getProjectFeatures(project.projectPath);
        if (features.length === 0) {
            return [new PixiEmptyTreeItem('No features declared in project', project)];
        }
        const projectEnvs = this.projectManager.getEnvironmentsForProject(project.projectPath);
        return features.map((f) => {
            const usedByEnvs = getReferencingEnvs(projectEnvs, f.name);
            const candidateEnvNames =
                f.name === 'default' ? ['default', ...projectEnvs.map((e) => e.pixiEnvName)] : usedByEnvs;
            const targetEnv =
                projectEnvs.find((e) => candidateEnvNames.includes(e.pixiEnvName) && e.pixiStatus === 'installed') ??
                projectEnvs.find((e) => candidateEnvNames.includes(e.pixiEnvName));
            return new PixiFeatureTreeItem(f, project, targetEnv, undefined, usedByEnvs);
        });
    }

    private async getEnvironmentItemsForProject(project: PixiProject): Promise<PixiProjectsTreeItem[]> {
        const envs = this.projectManager.getEnvironmentsForProject(project.projectPath);
        return envs.map((e) => new PixiEnvironmentTreeItem(e, project, e.features));
    }

    private async getProjectChildren(project: PixiProject): Promise<PixiProjectsTreeItem[]> {
        const items =
            this.currentViewMode === 'feature'
                ? await this.getFeatureItemsForProject(project)
                : await this.getEnvironmentItemsForProject(project);

        const config = workspace.getConfiguration('pixi.environments', Uri.file(project.projectPath));
        const position = config.get<'bottom' | 'top' | 'hidden'>('systemRequirementsPosition', 'bottom');

        if (position !== 'hidden') {
            const reqs = await getProjectSystemRequirements(project.projectPath, this.projectManager);
            if (reqs) {
                const reqItem = new PixiSystemRequirementsTreeItem(project, reqs);
                if (position === 'top') {
                    items.unshift(reqItem);
                } else {
                    items.push(reqItem);
                }
            }
        }

        return items;
    }

    public async getChildren(element?: PixiProjectsTreeItem): Promise<PixiProjectsTreeItem[]> {
        const projects = this.projectManager.getProjects();

        if (!element) {
            if (projects.length === 0) {
                return [];
            }
            if (projects.length === 1) {
                return this.getProjectChildren(projects[0]);
            }
            return projects.map((p) => new PixiProjectTreeItem(p));
        }

        if (element instanceof PixiProjectTreeItem) {
            return this.getProjectChildren(element.project);
        }

        if (element instanceof PixiFeatureTreeItem) {
            const packages =
                element.packages ??
                (await this.resolvePackagesForFeature(element.feature, element.project, element.env));
            return packages.map(
                (pkg) => new PixiPackageTreeItem(pkg, element.env, element.project, element.feature.name),
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

            const allFeatures = await this.getProjectFeatures(element.project.projectPath);
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
            const envFeatureNames = new Set([...(element.envFeatures ?? []), 'default']);
            const targetFeatures = allFeatures.filter(
                (f) => envFeatureNames.has(f.name) && (f.dependencies.length > 0 || f.pypiDependencies.length > 0),
            );
            const matchedPackages = new Set<PixiPackage>();
            const featureItems: PixiProjectsTreeItem[] = [];

            for (const f of targetFeatures) {
                const featurePkgs = this.matchFeaturePackages(f, sorted);
                for (const p of featurePkgs) {
                    matchedPackages.add(p);
                }

                featureItems.push(new PixiFeatureTreeItem(f, element.project, element.env, featurePkgs));
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

        if (element instanceof PixiSystemRequirementsTreeItem) {
            return Object.entries(element.requirements).map(
                ([prop, val]) => new PixiSystemRequirementPropertyTreeItem(prop, val ?? '', element.project),
            );
        }

        return [];
    }
}
