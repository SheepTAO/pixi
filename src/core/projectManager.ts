import * as fs from 'fs';
import * as path from 'path';
import {
    commands,
    ConfigurationTarget,
    Disposable,
    EventEmitter,
    ProgressLocation,
    Uri,
    window,
    workspace,
} from 'vscode';

import { runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { getWorkspacePersistentState } from '../common/persistentState';
import { getDefaultEnvironment, matchEnvironmentForUri, sortPixiEnvironments } from './environmentRules';
import { listPixiPackages } from './packageManager';
import { findManifestPath, isPixiProject, resolvePixiProjectPaths } from './projectDiscovery';
import { scanEnvironmentToolchains } from './toolchains';
import { PixiEnvironmentInfo, PixiEnvironmentStatus, PixiInfo, PixiPackage, PixiProject } from './types';

export class PixiProjectManager implements Disposable {
    private projectPaths: string[] = [];
    private projectToEnvs = new Map<string, PixiEnvironmentInfo[]>();
    private readonly packagesCache = new Map<string, Map<string, Promise<PixiPackage[]>>>();
    private readonly disposables: Disposable[] = [];

    private readonly _onDidProjectsChanged = new EventEmitter<string[]>();
    readonly onDidProjectsChanged = this._onDidProjectsChanged.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<void>();
    readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor() {
        // Watch manifest and lock files for changes (debounced by 500ms with project targeting)
        let pendingChangedUris: Uri[] = [];

        const scheduleRefresh = (uri: Uri) => {
            pendingChangedUris.push(uri);
            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
            }
            this.refreshTimer = setTimeout(async () => {
                const uris = pendingChangedUris;
                pendingChangedUris = [];

                const projectUris = new Set<string>();
                let needsFullRefresh = false;
                for (const u of uris) {
                    const filePath = path.normalize(u.fsPath);
                    const projectDir = this.findProjectForUri(u);
                    if (path.basename(filePath) === 'pyproject.toml') {
                        const knownManifest = projectDir ? this.getManifestPath(projectDir) : undefined;
                        const isKnownManifest =
                            knownManifest !== undefined && path.normalize(knownManifest) === filePath;
                        const isCurrentManifest = findManifestPath(path.dirname(filePath)) === filePath;
                        if (!isKnownManifest && !isCurrentManifest) {
                            continue;
                        }
                    }
                    if (projectDir) {
                        if (isPixiProject(projectDir)) {
                            projectUris.add(projectDir);
                        } else {
                            needsFullRefresh = true;
                            break;
                        }
                    } else if (isPixiProject(path.dirname(filePath))) {
                        needsFullRefresh = true;
                        break;
                    }
                }
                if (!needsFullRefresh && projectUris.size === 0) {
                    return;
                }

                const targetScope =
                    !needsFullRefresh && projectUris.size === 1 ? Uri.file(Array.from(projectUris)[0]) : undefined;

                traceVerbose(
                    `Manifest change triggered refresh (targeted: ${targetScope ? targetScope.fsPath : 'all projects'})`,
                );
                await this.refresh(targetScope);
            }, 500);
        };

        const watcher = workspace.createFileSystemWatcher('{pixi.toml,pyproject.toml,pixi.lock}');

        this.disposables.push(
            watcher,
            watcher.onDidChange(scheduleRefresh),
            watcher.onDidCreate(scheduleRefresh),
            watcher.onDidDelete(scheduleRefresh),
            workspace.onDidChangeWorkspaceFolders(async () => {
                await this.refreshAll();
            }),
        );
    }

    private promptedAutoInstallProjects = new Set<string>();

    public async initialize(): Promise<void> {
        await this.refreshAll();
        await this.checkAutoInstall();
    }

    public getProjectPaths(): string[] {
        return [...this.projectPaths];
    }

    public getManifestPath(projectPath: string): string | undefined {
        const envs = this.projectToEnvs.get(path.normalize(projectPath));
        if (envs && envs.length > 0 && envs[0].manifestPath) {
            return envs[0].manifestPath;
        }
        return findManifestPath(projectPath);
    }

    public getProjectName(projectPath: string): string {
        const normalized = path.normalize(projectPath);
        const envs = this.projectToEnvs.get(normalized);
        return (envs && envs.length > 0 && envs[0].projectName) || path.basename(normalized);
    }

    public getProjects(): PixiProject[] {
        const projects = this.projectPaths.map((p) => {
            return {
                name: this.getProjectName(p),
                projectPath: p,
                manifestPath: this.getManifestPath(p) || path.join(p, 'pixi.toml'),
            };
        });
        return projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    public getEnvironmentsForProject(projectPath: string): PixiEnvironmentInfo[] {
        const normalized = path.normalize(projectPath);
        return this.projectToEnvs.get(normalized) || [];
    }

    public getAllEnvironments(): PixiEnvironmentInfo[] {
        return Array.from(this.projectToEnvs.values()).flat();
    }

    private getProjectKey(projectPath: string): string {
        const normalized = path.normalize(projectPath);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    public clearPackagesCache(projectPath?: string): void {
        if (projectPath) {
            this.packagesCache.delete(this.getProjectKey(projectPath));
        } else {
            this.packagesCache.clear();
        }
    }

    public async getPackagesForEnvironment(envName: string, projectPath: string): Promise<PixiPackage[]> {
        const projectKey = this.getProjectKey(projectPath);
        let projectMap = this.packagesCache.get(projectKey);
        if (!projectMap) {
            projectMap = new Map<string, Promise<PixiPackage[]>>();
            this.packagesCache.set(projectKey, projectMap);
        }

        const cached = projectMap.get(envName);
        if (cached) {
            return cached;
        }

        const env = this.getEnvironmentsForProject(projectPath).find((e) => e.pixiEnvName === envName);
        if (env && env.pixiStatus === 'incompatible') {
            const empty = Promise.resolve([]);
            projectMap.set(envName, empty);
            return empty;
        }

        const promise = listPixiPackages(envName, projectPath).then((pkgs) => {
            traceVerbose(`Loaded ${pkgs.length} packages for environment '${envName}' in ${projectPath}`);
            return pkgs;
        });
        projectMap.set(envName, promise);
        return promise;
    }

    public findProjectForUri(uri: Uri): string | undefined {
        const filePath = path.normalize(uri.fsPath);
        const isWindows = process.platform === 'win32';
        const normFilePath = isWindows ? filePath.toLowerCase() : filePath;
        const sortedPaths = [...this.projectPaths].sort((a, b) => b.length - a.length);
        for (const projectPath of sortedPaths) {
            const normProjectPath = isWindows ? projectPath.toLowerCase() : projectPath;
            const sep = path.sep;
            if (normFilePath === normProjectPath || normFilePath.startsWith(normProjectPath + sep)) {
                return projectPath;
            }
        }
        return undefined;
    }

    public resolveProjectActiveOrDefault(
        projectPath: string,
        envs = this.getEnvironmentsForProject(projectPath),
    ): PixiEnvironmentInfo | undefined {
        if (envs.length === 0) {
            return undefined;
        }
        const activeName = getWorkspacePersistentState().get<string>(`projectEnvName:${projectPath}`);
        if (activeName) {
            const match = envs.find((e) => e.pixiEnvName === activeName);
            if (match) {
                return match;
            }
        }
        return getDefaultEnvironment(envs);
    }

    public getEnvironmentForUri(uri: Uri): PixiEnvironmentInfo | undefined {
        const projectPath = this.findProjectForUri(uri);
        if (!projectPath) {
            return undefined;
        }

        const envs = this.getEnvironmentsForProject(projectPath);
        if (envs.length <= 1) {
            return envs[0];
        }

        return matchEnvironmentForUri(uri, projectPath, envs) ?? this.resolveProjectActiveOrDefault(projectPath, envs);
    }

    public async refresh(scope?: Uri): Promise<void> {
        if (scope) {
            const projectPath = this.findProjectForUri(scope);
            if (projectPath && isPixiProject(projectPath)) {
                await this.refreshProject(projectPath);
                this._onDidChangeEnvironments.fire();
                return;
            }
        }

        await this.refreshAll();
    }

    private async refreshAll(): Promise<void> {
        const oldPaths = new Set(this.projectPaths);
        this.projectPaths = resolvePixiProjectPaths();
        await this.updateHasPixiProjectContext();

        const currentPaths = new Set(this.projectPaths);
        const pathsChanged = oldPaths.size !== currentPaths.size || [...oldPaths].some((p) => !currentPaths.has(p));

        // Clean up deleted projects
        for (const knownPath of this.projectToEnvs.keys()) {
            if (!currentPaths.has(knownPath)) {
                this.projectToEnvs.delete(knownPath);
                this.clearPackagesCache(knownPath);
            }
        }

        if (this.projectPaths.length > 0) {
            await window.withProgress(
                {
                    location: ProgressLocation.Window,
                    title: 'Pixi: Refreshing projects...',
                },
                async () => {
                    await Promise.all(this.projectPaths.map((p) => this.refreshProject(p)));
                },
            );
        }

        if (pathsChanged) {
            this._onDidProjectsChanged.fire(this.projectPaths);
        }
        this._onDidChangeEnvironments.fire();
    }

    private async refreshProject(projectPath: string): Promise<void> {
        const normalized = path.normalize(projectPath);
        this.clearPackagesCache(normalized);
        try {
            const stdout = await runPixi(['info', '--json'], { cwd: normalized });
            const pixiInfo: PixiInfo = safeJsonParse<PixiInfo>(stdout, {} as PixiInfo);

            if (!pixiInfo.project_info) {
                traceVerbose(`No project_info returned from pixi info for ${normalized}`);
                this.projectToEnvs.set(normalized, []);
                return;
            }

            const projectName = pixiInfo.project_info.name;
            const manifestPath = pixiInfo.project_info.manifest_path;
            const currentPlatform = pixiInfo.platform;

            const envs: PixiEnvironmentInfo[] = await Promise.all(
                (pixiInfo.environments_info || []).map(async (rawEnv) => {
                    const platforms = rawEnv.platforms || [];
                    const platformNames = platforms.map((p) => (typeof p === 'string' ? p : p.name));
                    const isDeclaredForHost =
                        !currentPlatform ||
                        platforms.length === 0 ||
                        Boolean(rawEnv.resolved_platform) ||
                        platforms.some((p) =>
                            typeof p === 'string'
                                ? p === currentPlatform
                                : p.name === currentPlatform || p.subdir === currentPlatform,
                        );

                    let status: PixiEnvironmentStatus;
                    let statusReason: string | undefined;

                    if (fs.existsSync(rawEnv.prefix)) {
                        status = 'installed';
                    } else if (!isDeclaredForHost) {
                        status = 'incompatible';
                        statusReason = `Environment '${rawEnv.name}' declared platforms [${platformNames.join(', ')}], which is incompatible with host platform '${currentPlatform}'.`;
                    } else {
                        status = 'uninstalled';
                        statusReason = `Environment '${rawEnv.name}' is not installed on disk. Run 'pixi install -e ${rawEnv.name}' to create it.`;
                    }

                    const envInfo: PixiEnvironmentInfo = {
                        pixiEnvName: rawEnv.name,
                        prefix: rawEnv.prefix,
                        projectPath: normalized,
                        projectName,
                        manifestPath,
                        pixiStatus: status,
                        statusReason,
                        platforms: rawEnv.platforms,
                    };

                    if (status === 'installed') {
                        const toolchains = await scanEnvironmentToolchains(rawEnv.prefix);
                        envInfo.toolchains = toolchains;
                    }

                    return envInfo;
                }),
            );

            this.projectToEnvs.set(normalized, sortPixiEnvironments(envs));
        } catch (error) {
            traceError(`Failed to refresh Pixi project at ${normalized}:`, error);
            this.projectToEnvs.set(normalized, []);
        }
    }

    private async checkAutoInstall(): Promise<void> {
        for (const projectPath of this.projectPaths) {
            const envs = this.getEnvironmentsForProject(projectPath);
            const uninstalledEnvs = envs.filter((e) => e.pixiStatus === 'uninstalled');

            if (uninstalledEnvs.length === 0) {
                this.promptedAutoInstallProjects.delete(projectPath);
                continue;
            }

            if (this.promptedAutoInstallProjects.has(projectPath)) {
                continue;
            }

            const config = workspace.getConfiguration('pixi', Uri.file(projectPath));
            const policy = config.get<'prompt' | 'always' | 'never'>('autoInstallOnOpen', 'prompt');
            if (policy === 'never') {
                continue;
            }

            this.promptedAutoInstallProjects.add(projectPath);
            const projectName = envs[0]?.projectName || path.basename(projectPath);

            if (policy === 'always') {
                traceVerbose(`Auto-installing environments for '${projectName}' (${projectPath})`);
                await commands.executeCommand('pixi.install', Uri.file(projectPath));
            } else if (policy === 'prompt') {
                const uninstalledNames = uninstalledEnvs.map((e) => `'${e.pixiEnvName}'`).join(', ');
                window
                    .showInformationMessage(
                        `Pixi environment(s) ${uninstalledNames} for project '${projectName}' are not installed. Would you like to install now?`,
                        'Install',
                        'Never for this Project',
                    )
                    .then(async (selection) => {
                        if (selection === 'Install') {
                            await commands.executeCommand('pixi.install', Uri.file(projectPath));
                        } else if (selection === 'Never for this Project') {
                            await config.update('autoInstallOnOpen', 'never', ConfigurationTarget.WorkspaceFolder);
                        }
                    });
            }
        }
    }

    private async updateHasPixiProjectContext(): Promise<void> {
        const hasPixi = this.projectPaths.length > 0;
        await commands.executeCommand('setContext', 'pixi.hasPixiProject', hasPixi);
    }

    public dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this._onDidProjectsChanged.dispose();
        this._onDidChangeEnvironments.dispose();
        this.packagesCache.clear();
        this.projectToEnvs.clear();
        Disposable.from(...this.disposables).dispose();
    }
}
