import * as path from 'path';
import {
    commands,
    Disposable,
    Event,
    EventEmitter,
    MarkdownString,
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
import { PixiPackageUpdateService } from '../core/packageUpdateService';
import { PathMap } from '../core/projectDiscovery';
import { PixiProjectManager } from '../core/projectManager';
import {
    formatSystemRequirementsSummary,
    getProjectSystemRequirements,
    SYSTEM_REQUIREMENT_DESCRIPTORS,
    SystemRequirementsRecord,
} from '../core/systemRequirements';
import { formatToolchainDetails, formatToolchainSummary } from '../core/toolchains';
import { PixiEnvironmentInfo, PixiPackage, PixiProject } from '../core/types';

export interface ProjectSummaryMetadata {
    platforms?: string[];
    channels?: string[];
    envCount?: number;
    featureCount?: number;
    taskCount?: number;
    descriptionText?: string;
    requiresPixi?: string;
}

function buildWorkspaceTooltip(
    project: PixiProject,
    manifestName: string,
    versionStr?: string,
    summary: ProjectSummaryMetadata = {},
    isHeader = false,
): MarkdownString {
    const md = new MarkdownString('', true);
    md.isTrusted = true;
    md.supportHtml = true;

    const header = versionStr
        ? `### $(root-folder) ${project.name} \`${versionStr}\``
        : `### $(root-folder) ${project.name}`;
    md.appendMarkdown(`${header}\n\n`);

    if (summary.descriptionText) {
        md.appendMarkdown(`*${summary.descriptionText}*\n\n`);
    }

    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`- **Manifest**: \`${manifestName}\`\n`);
    md.appendMarkdown(`- **Path**: \`${project.projectPath}\`\n`);

    if (project.pixiFolderSize) {
        md.appendMarkdown(`- **Prefix Size**: \`${project.pixiFolderSize}\`\n`);
    }

    const platforms = summary.platforms ?? [];
    if (platforms.length > 0) {
        md.appendMarkdown(`- **Platforms (${platforms.length})**: ${platforms.map((p) => `\`${p}\``).join(', ')}\n`);
    }

    const channels = summary.channels ?? [];
    if (channels.length > 0) {
        md.appendMarkdown(`- **Channels**: ${channels.map((c) => `\`${c}\``).join(', ')}\n`);
    }

    if (summary.requiresPixi) {
        md.appendMarkdown(`- **Requires Pixi**: \`${summary.requiresPixi}\`\n`);
    }

    if (summary.taskCount !== undefined) {
        md.appendMarkdown(`- **Tasks**: ${summary.taskCount} task${summary.taskCount === 1 ? '' : 's'} declared\n`);
    }

    const counts: string[] = [];
    const envCount = summary.envCount ?? 0;
    const featureCount = summary.featureCount ?? 0;
    if (envCount > 0) {
        counts.push(`${envCount} environment${envCount > 1 ? 's' : ''}`);
    }
    if (featureCount > 0) {
        counts.push(`${featureCount} feature${featureCount > 1 ? 's' : ''}`);
    }
    if (counts.length > 0) {
        md.appendMarkdown(`- **Workspace Scope**: ${counts.join(', ')}\n`);
    }

    md.appendMarkdown('\n---\n\n');
    if (isHeader) {
        md.appendMarkdown('*Click to open manifest • Right-click for workspace actions*');
    } else {
        md.appendMarkdown('*Click to expand or collapse • Right-click for options*');
    }
    return md;
}

export class PixiWorkspaceHeaderTreeItem extends TreeItem {
    constructor(
        public readonly project: PixiProject,
        summary: ProjectSummaryMetadata = {},
    ) {
        super(project.name, TreeItemCollapsibleState.None);
        const manifestName = path.basename(project.manifestPath);
        const versionStr = project.version ? `v${project.version}` : undefined;
        this.description = versionStr ? `${versionStr} (${manifestName})` : `(${manifestName})`;
        this.iconPath = new ThemeIcon('root-folder', new ThemeColor('symbolIcon.folderForeground'));
        this.contextValue = 'pixiWorkspaceHeader';

        this.command = {
            command: 'pixi.openManifest',
            title: 'Open Manifest',
            arguments: [this],
        };

        this.tooltip = buildWorkspaceTooltip(project, manifestName, versionStr, summary, true);
    }
}

export class PixiProjectTreeItem extends TreeItem {
    constructor(
        public readonly project: PixiProject,
        summary: ProjectSummaryMetadata = {},
    ) {
        super(project.name, TreeItemCollapsibleState.Expanded);
        const manifestName = path.basename(project.manifestPath);
        const versionStr = project.version ? `v${project.version}` : undefined;
        const taskBadge =
            summary.taskCount !== undefined
                ? ` • ${summary.taskCount === 1 ? '1 task' : `${summary.taskCount} tasks`}`
                : '';
        this.description = versionStr ? `${versionStr} (${manifestName})${taskBadge}` : `(${manifestName})${taskBadge}`;
        this.iconPath = new ThemeIcon('root-folder');
        this.contextValue = 'pixiProject';

        this.tooltip = buildWorkspaceTooltip(project, manifestName, versionStr, summary, false);
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
        this.iconPath = new ThemeIcon('references', new ThemeColor('descriptionForeground'));
        this.contextValue = 'pixiTransitiveGroup';

        const md = new MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;
        md.appendMarkdown(`### $(references) Transitive Dependencies\n\n`);
        md.appendMarkdown(`- **Environment**: \`${env.pixiEnvName}\`\n`);
        md.appendMarkdown(`- **Project**: ${project.name}\n`);
        md.appendMarkdown(
            `- **Packages**: ${packages.length} transitive package${packages.length === 1 ? '' : 's'}\n\n`,
        );
        md.appendMarkdown('---\n\n*Click to expand or collapse*');
        this.tooltip = md;
    }
}

export class PixiPackageTreeItem extends TreeItem {
    constructor(
        public readonly pkg: PixiPackage,
        public readonly env: PixiEnvironmentInfo | undefined,
        public readonly project: PixiProject,
        public readonly featureName?: string,
        public readonly outdatedVer?: string,
    ) {
        super(pkg.name, TreeItemCollapsibleState.None);
        const updateArrow = outdatedVer && outdatedVer !== pkg.version ? ` (↑ ${outdatedVer})` : '';

        if (pkg.is_editable || pkg.is_local) {
            const tag = pkg.is_editable ? 'editable' : 'local';
            this.description = pkg.version ? `${pkg.version} (${tag})` : `(${tag})`;
            this.iconPath = new ThemeIcon('folder-library', new ThemeColor('charts.blue'));
        } else {
            this.description = pkg.version
                ? pkg.kind === 'pypi'
                    ? `${pkg.version}${updateArrow} (pypi)`
                    : `${pkg.version}${updateArrow}`
                : pkg.kind === 'pypi'
                  ? '(pypi)'
                  : undefined;
            this.iconPath = pkg.is_explicit
                ? new ThemeIcon('package')
                : new ThemeIcon('symbol-field', new ThemeColor('descriptionForeground'));
        }

        const md = new MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;

        const isLocal = Boolean(pkg.is_editable || pkg.is_local);
        const iconName = isLocal ? 'folder-library' : 'package';
        const versionHeading = pkg.version ? ` \`v${pkg.version}\`` : '';
        md.appendMarkdown(`### $(${iconName}) ${pkg.name}${versionHeading}\n\n`);

        if (outdatedVer && outdatedVer !== pkg.version) {
            md.appendMarkdown(`$(arrow-up) **Update available**: \`v${outdatedVer}\`\n\n`);
        }

        const details: string[] = [];
        const kindLabel = pkg.kind ? pkg.kind.toUpperCase() : 'Conda';
        const typeLabel = pkg.is_explicit ? 'explicit' : 'transitive';
        details.push(`- **Type**: ${kindLabel} (${typeLabel})`);

        if (this.featureName) {
            details.push(`- **Feature**: \`${this.featureName}\``);
        }
        if (isLocal) {
            const editLabel = pkg.is_editable ? 'Editable ' : '';
            details.push(`- **Subpackage**: Local ${editLabel}Subpackage`);
        }
        if (pkg.local_path) {
            details.push(`- **Path**: \`${pkg.local_path}\``);
        }
        if (pkg.build) {
            details.push(`- **Build**: \`${pkg.build}\``);
        }
        if (pkg.license) {
            details.push(`- **License**: ${pkg.license}`);
        }
        if (pkg.source && !pkg.is_local) {
            details.push(`- **Source**: ${pkg.source}`);
        }

        md.appendMarkdown(details.join('\n') + '\n\n');

        if (pkg.local_manifest_path) {
            md.appendMarkdown('---\n\n*Click to open subpackage manifest*');
            this.command = {
                command: 'vscode.open',
                title: 'Open Subpackage Manifest',
                arguments: [Uri.file(pkg.local_manifest_path)],
            };
        }
        this.tooltip = md;
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
            const showToolchains = workspace
                .getConfiguration('pixi.environments', Uri.file(env.projectPath))
                .get<boolean>('showToolchains', true);
            if (showToolchains && toolchainSummary) {
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

        const md = new MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;

        const statusIcon =
            env.pixiStatus === 'installed'
                ? 'pass-filled'
                : env.pixiStatus === 'uninstalled'
                  ? 'circle-outline'
                  : 'error';
        md.appendMarkdown(`### $(${statusIcon}) ${env.pixiEnvName}\n\n`);

        const details: string[] = [];
        details.push(`- **Status**: ${env.pixiStatus}`);
        details.push(`- **Project**: ${project.name}`);
        details.push(`- **Prefix**: \`${env.prefix}\``);

        if (env.solveGroup) {
            details.push(`- **Solve Group**: \`${env.solveGroup}\``);
        }
        if (env.environmentSize) {
            details.push(`- **Size on Disk**: \`${env.environmentSize}\``);
        }
        if (envFeatures && envFeatures.length > 0) {
            details.push(`- **Features**: ${envFeatures.map((f) => `\`${f}\``).join(', ')}`);
        }
        if (env.statusReason) {
            details.push(`- **Reason**: ${env.statusReason}`);
        }
        if (toolchainSummary) {
            details.push(`- **Toolchains**: ${toolchainSummary}`);
        }
        if (env.resolvedPlatform) {
            details.push(`- **Platform**: \`${env.resolvedPlatform}\``);
        }

        md.appendMarkdown(details.join('\n') + '\n\n');
        if (toolchainLines.length > 0) {
            md.appendMarkdown('---\n\n' + toolchainLines.join('\n\n') + '\n\n');
        }

        if (env.pixiStatus === 'uninstalled') {
            md.appendMarkdown('---\n\n*Click to install environment*');
        } else if (env.pixiStatus === 'installed') {
            md.appendMarkdown('---\n\n*Right-click for environment actions*');
        }
        this.tooltip = md;
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
            const md = new MarkdownString('', true);
            md.isTrusted = true;
            md.supportHtml = true;
            md.appendMarkdown(`### $(symbol-namespace) ${feature.name}\n\n`);
            md.appendMarkdown(`- **Environment**: \`${env.pixiEnvName}\`\n`);
            md.appendMarkdown(`- **Packages**: ${packages.length} package${packages.length === 1 ? '' : 's'}\n`);
            this.tooltip = md;
        } else {
            this.description = isDefault
                ? '(Global)'
                : usedByEnvs.length > 0
                  ? `Used by: ${usedByEnvs.join(', ')}`
                  : '(Unused)';
            const md = new MarkdownString('', true);
            md.isTrusted = true;
            md.supportHtml = true;
            md.appendMarkdown(`### $(symbol-namespace) ${feature.name}\n\n`);
            md.appendMarkdown(`- **Project**: ${project.name}\n`);
            if (isDefault) {
                md.appendMarkdown('- **Scope**: Global (available to all environments)\n');
            } else {
                const usedStr = usedByEnvs.length > 0 ? usedByEnvs.map((e) => `\`${e}\``).join(', ') : 'None';
                md.appendMarkdown(`- **Used by**: ${usedStr}\n`);
            }
            md.appendMarkdown(`- **Conda Dependencies**: ${feature.dependencies.length}\n`);
            md.appendMarkdown(`- **PyPI Dependencies**: ${feature.pypiDependencies.length}\n`);
            if (feature.tasks && feature.tasks.length > 0) {
                md.appendMarkdown(`- **Tasks**: ${feature.tasks.map((t) => `\`${t}\``).join(', ')}\n`);
            }
            this.tooltip = md;
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

        const md = new MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;
        md.appendMarkdown(`### $(server-process) System Requirements\n\n`);
        md.appendMarkdown(`- **Project**: ${project.name}\n\n`);
        md.appendMarkdown('---\n\n');
        for (const [k, v] of Object.entries(requirements)) {
            md.appendMarkdown(`- **${k}**: \`${v}\`\n`);
        }
        md.appendMarkdown('\n---\n\n*Click to expand or configure properties in manifest*');
        this.tooltip = md;
    }
}

export class PixiSystemRequirementPropertyTreeItem extends TreeItem {
    constructor(
        public readonly propertyName: string,
        public readonly propertyValue: string,
        public readonly project: PixiProject,
    ) {
        const descriptor = SYSTEM_REQUIREMENT_DESCRIPTORS.find((d) => d.id === propertyName);
        const displayLabel = descriptor?.label || propertyName;
        super(displayLabel, TreeItemCollapsibleState.None);
        const iconName = descriptor?.icon || 'symbol-property';
        this.iconPath = new ThemeIcon(iconName);
        this.contextValue = 'pixiSystemRequirementProperty';
        this.description = propertyValue;

        const md = new MarkdownString('', true);
        md.isTrusted = true;
        md.supportHtml = true;
        md.appendMarkdown(`### $(${iconName}) ${displayLabel}\n\n`);
        if (descriptor?.description) {
            md.appendMarkdown(`*${descriptor.description}*\n\n`);
        }
        md.appendMarkdown(`- **Requirement**: \`${propertyName} = "${propertyValue}"\`\n`);
        md.appendMarkdown(`- **Project**: ${project.name}\n\n`);
        md.appendMarkdown('---\n\n*Click to edit requirement in manifest*');
        this.tooltip = md;

        this.command = {
            command: 'pixi.systemRequirements.editProperty',
            title: 'Edit Requirement',
            arguments: [project.projectPath, propertyName],
        };
    }
}

export type ProjectsViewMode = 'environment' | 'feature';

export type PixiProjectsTreeItem =
    | PixiWorkspaceHeaderTreeItem
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
    private readonly featuresCache = new PathMap<Promise<WorkspaceListEntry[]>>();

    constructor(
        private readonly projectManager: PixiProjectManager,
        private readonly packageUpdateService?: PixiPackageUpdateService,
    ) {
        const config = workspace.getConfiguration('pixi.environments');
        this.currentViewMode = config.get<ProjectsViewMode>('viewMode', 'environment');
        void commands.executeCommand('setContext', 'pixi.environmentsViewMode', this.currentViewMode);

        this.disposables.push(
            this.projectManager.onDidChangeEnvironments((projectPath) => this.refresh(projectPath)),
            this.packageUpdateService
                ? this.packageUpdateService.onDidChangeOutdatedPackages(() => this._onDidChangeTreeData.fire())
                : Disposable.from(),
            workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('pixi.packages.displayMode') ||
                    e.affectsConfiguration('pixi.packages.checkForUpdates')
                ) {
                    this._onDidChangeTreeData.fire();
                }
                if (
                    e.affectsConfiguration('pixi.environments.viewMode') ||
                    e.affectsConfiguration('pixi.environments.systemRequirementsPosition') ||
                    e.affectsConfiguration('pixi.environments.showToolchains') ||
                    e.affectsConfiguration('pixi.environments.showWorkspaceHeader')
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

    public refresh(projectPath?: string): void {
        if (projectPath) {
            this.featuresCache.delete(projectPath);
        } else {
            this.featuresCache.clear();
        }
        this.updateViewDescription();
        this._onDidChangeTreeData.fire();
    }

    private updateViewDescription(): void {
        if (this.treeView) {
            this.treeView.description = this.currentViewMode === 'feature' ? 'features' : undefined;
        }
        void commands.executeCommand('setContext', 'pixi.environmentsViewMode', this.currentViewMode);
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
        let promise = this.featuresCache.get(projectPath);
        if (!promise) {
            promise = getWorkspaceFeatures(projectPath);
            this.featuresCache.set(projectPath, promise);
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

    private async resolveProjectSummary(project: PixiProject): Promise<{
        platforms: string[];
        channels: string[];
        envCount: number;
        featureCount: number;
        descriptionText?: string;
        requiresPixi?: string;
    }> {
        const platforms = this.projectManager.getPlatformsForProject(project.projectPath).map((p) => p.name);
        const channels = this.projectManager.getProjectConfiguredChannels(project.projectPath);
        const envs = this.projectManager.getEnvironmentsForProject(project.projectPath);
        let featureCount = 0;
        try {
            const features = await this.getProjectFeatures(project.projectPath);
            featureCount = features.length;
        } catch {
            // ignore
        }

        return {
            platforms,
            channels,
            envCount: envs.length,
            featureCount,
            descriptionText: project.description || undefined,
            requiresPixi: project.requiresPixi || undefined,
        };
    }

    private async createWorkspaceHeaderTreeItem(project: PixiProject): Promise<PixiWorkspaceHeaderTreeItem> {
        const summary = await this.resolveProjectSummary(project);
        return new PixiWorkspaceHeaderTreeItem(project, summary);
    }

    private async createProjectTreeItem(project: PixiProject): Promise<PixiProjectTreeItem> {
        const summary = await this.resolveProjectSummary(project);
        return new PixiProjectTreeItem(project, summary);
    }

    private async getProjectChildren(
        project: PixiProject,
        isSingleProjectRoot = false,
    ): Promise<PixiProjectsTreeItem[]> {
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

        if (isSingleProjectRoot) {
            const showWorkspaceHeader = config.get<boolean>('showWorkspaceHeader', true);
            if (showWorkspaceHeader) {
                const headerItem = await this.createWorkspaceHeaderTreeItem(project);
                items.unshift(headerItem);
            }
        }

        return items;
    }

    private getOutdatedVersion(projectPath: string, envName?: string, pkgName?: string): string | undefined {
        if (!this.packageUpdateService || !envName || !pkgName) {
            return undefined;
        }
        return this.packageUpdateService.getOutdatedPackage(projectPath, envName, pkgName)?.afterVer;
    }

    public async getChildren(element?: PixiProjectsTreeItem): Promise<PixiProjectsTreeItem[]> {
        const projects = this.projectManager.getProjects();

        if (!element) {
            if (projects.length === 0) {
                return [];
            }
            if (projects.length === 1) {
                return this.getProjectChildren(projects[0], true);
            }
            return Promise.all(projects.map((p) => this.createProjectTreeItem(p)));
        }

        if (element instanceof PixiWorkspaceHeaderTreeItem) {
            return [];
        }

        if (element instanceof PixiProjectTreeItem) {
            return this.getProjectChildren(element.project, false);
        }

        if (element instanceof PixiFeatureTreeItem) {
            if (this.packageUpdateService) {
                void this.packageUpdateService.checkForUpdates(element.project.projectPath);
            }
            const packages =
                element.packages ??
                (await this.resolvePackagesForFeature(element.feature, element.project, element.env));
            return packages.map(
                (pkg) =>
                    new PixiPackageTreeItem(
                        pkg,
                        element.env,
                        element.project,
                        element.feature.name,
                        this.getOutdatedVersion(element.project.projectPath, element.env?.pixiEnvName, pkg.name),
                    ),
            );
        }

        if (element instanceof PixiEnvironmentTreeItem) {
            if (element.env.pixiStatus !== 'installed') {
                return [];
            }
            if (this.packageUpdateService) {
                void this.packageUpdateService.checkForUpdates(element.project.projectPath);
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
                    return sorted.map(
                        (pkg) =>
                            new PixiPackageTreeItem(
                                pkg,
                                element.env,
                                element.project,
                                undefined,
                                this.getOutdatedVersion(element.project.projectPath, element.env.pixiEnvName, pkg.name),
                            ),
                    );
                }

                const explicit = sorted.filter((p) => p.is_explicit);
                if (displayMode === 'explicitOnly') {
                    if (explicit.length === 0) {
                        return [new PixiEmptyTreeItem('No explicit packages found', element.project, element.env)];
                    }
                    return explicit.map(
                        (pkg) =>
                            new PixiPackageTreeItem(
                                pkg,
                                element.env,
                                element.project,
                                undefined,
                                this.getOutdatedVersion(element.project.projectPath, element.env.pixiEnvName, pkg.name),
                            ),
                    );
                }

                // 'grouped' mode (default)
                const transitive = sorted.filter((p) => !p.is_explicit);
                const result: PixiProjectsTreeItem[] = explicit.map(
                    (pkg) =>
                        new PixiPackageTreeItem(
                            pkg,
                            element.env,
                            element.project,
                            undefined,
                            this.getOutdatedVersion(element.project.projectPath, element.env.pixiEnvName, pkg.name),
                        ),
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
            return element.packages.map(
                (pkg) =>
                    new PixiPackageTreeItem(
                        pkg,
                        element.env,
                        element.project,
                        undefined,
                        this.getOutdatedVersion(element.project.projectPath, element.env.pixiEnvName, pkg.name),
                    ),
            );
        }

        if (element instanceof PixiSystemRequirementsTreeItem) {
            return Object.entries(element.requirements).map(
                ([prop, val]) => new PixiSystemRequirementPropertyTreeItem(prop, val ?? '', element.project),
            );
        }

        return [];
    }
}
