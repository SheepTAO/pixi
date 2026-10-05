import * as fs from 'fs';
import * as path from 'path';
import {
    commands,
    ConfigurationTarget,
    Disposable,
    EventEmitter,
    LogOutputChannel,
    ProgressLocation,
    Uri,
    window,
    workspace,
} from 'vscode';

import { runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { getDefaultEnvironment, matchEnvironmentForUri, sortPixiEnvironments } from './environmentRules';
import { listPixiPackages, PixiPackage } from './packageManager';
import { findManifestPath, isPixiProject, resolvePixiProjectPaths } from './projectDiscovery';
import { scanEnvironmentToolchains } from './toolchains';
import { PixiEnvironmentInfo, PixiEnvironmentStatus, PixiInfo, PixiProject } from './types';

export class PixiProjectManager implements Disposable {
    private projectPaths: string[] = [];
    private projectToEnvs = new Map<string, PixiEnvironmentInfo[]>();
    private packagesCache = new Map<string, PixiPackage[]>();
    private packagesInFlight = new Map<string, Promise<PixiPackage[]>>();
    private readonly disposables: Disposable[] = [];

    private readonly _onDidProjectsChanged = new EventEmitter<string[]>();
    readonly onDidProjectsChanged = this._onDidProjectsChanged.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<void>();
    readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(public readonly log?: LogOutputChannel) {
        // Watch manifest and lock files for changes (debounced by 500ms with project targeting)
        let pendingChangedUris: Uri[] = [];

        const scheduleRefresh = (uri?: Uri) => {
            if (uri) {
                pendingChangedUris.push(uri);
            }
            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
            }
            this.refreshTimer = setTimeout(async () => {
                const uris = pendingChangedUris;
                pendingChangedUris = [];

                let targetScope: Uri | undefined = undefined;
                if (uris.length > 0) {
                    const projectUris = new Set<string>();
                    for (const u of uris) {
                        const projectDir = this.findProjectForUri(u);
                        if (projectDir) {
                            projectUris.add(projectDir);
                        } else {
                            projectUris.clear();
                            break;
                        }
                    }
                    if (projectUris.size === 1) {
                        targetScope = Uri.file(Array.from(projectUris)[0]);
                    }
                }

                traceVerbose(
                    `Manifest change triggered refresh (targeted: ${targetScope ? targetScope.fsPath : 'all projects'})`,
                );
                await this.refresh(targetScope);
            }, 500);
        };

        const watcher = workspace.createFileSystemWatcher('**/{pixi.toml,pyproject.toml,pixi.lock}');

        this.disposables.push(
            watcher,
            watcher.onDidChange(scheduleRefresh),
            watcher.onDidCreate(scheduleRefresh),
            watcher.onDidDelete(scheduleRefresh),
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

    public getProjects(): PixiProject[] {
        const projects = this.projectPaths.map((p) => {
            const envs = this.projectToEnvs.get(path.normalize(p));
            return {
                name: envs && envs.length > 0 ? envs[0].projectName : path.basename(p),
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

    public clearPackagesCache(projectPath?: string): void {
        if (projectPath) {
            const normalized = path.normalize(projectPath);
            const isWindows = process.platform === 'win32';
            const targetPrefix = isWindows ? (normalized + ':').toLowerCase() : normalized + ':';

            for (const map of [this.packagesCache, this.packagesInFlight]) {
                for (const key of map.keys()) {
                    const compKey = isWindows ? key.toLowerCase() : key;
                    if (compKey.startsWith(targetPrefix)) {
                        map.delete(key);
                    }
                }
            }
        } else {
            this.packagesCache.clear();
            this.packagesInFlight.clear();
        }
    }

    public async getPackagesForEnvironment(envName: string, projectPath: string): Promise<PixiPackage[]> {
        const cacheKey = `${path.normalize(projectPath)}:${envName}`;
        if (this.packagesCache.has(cacheKey)) {
            return this.packagesCache.get(cacheKey)!;
        }

        const env = this.getEnvironmentsForProject(projectPath).find((e) => e.pixiEnvName === envName);
        if (env && env.pixiStatus === 'incompatible') {
            this.packagesCache.set(cacheKey, []);
            return [];
        }

        let inFlight = this.packagesInFlight.get(cacheKey);
        if (!inFlight) {
            inFlight = listPixiPackages(envName, projectPath)
                .then((pkgs) => {
                    this.packagesCache.set(cacheKey, pkgs);
                    traceVerbose(`Loaded ${pkgs.length} packages for environment '${envName}' in ${projectPath}`);
                    return pkgs;
                })
                .catch((error) => {
                    traceError(`Failed to fetch packages for environment '${envName}':`, error);
                    return [];
                })
                .finally(() => {
                    this.packagesInFlight.delete(cacheKey);
                });
            this.packagesInFlight.set(cacheKey, inFlight);
        }

        return inFlight;
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

    public getEnvironmentForUri(uri: Uri): PixiEnvironmentInfo | undefined {
        const projectPath = this.findProjectForUri(uri);
        if (!projectPath) {
            return undefined;
        }

        const envs = this.getEnvironmentsForProject(projectPath);
        if (envs.length === 0) {
            return undefined;
        }
        if (envs.length === 1) {
            return envs[0];
        }

        const matched = matchEnvironmentForUri(uri, projectPath, envs);
        if (matched) {
            return matched;
        }

        return getDefaultEnvironment(envs);
    }

    public async refresh(scope?: Uri): Promise<void> {
        if (scope) {
            const projectPath = this.findProjectForUri(scope);
            if (projectPath && isPixiProject(projectPath)) {
                const normalized = path.normalize(projectPath);
                if (!this.projectPaths.includes(normalized)) {
                    this.projectPaths.push(normalized);
                    this.projectPaths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
                    await this.updateHasPixiProjectContext();
                    this._onDidProjectsChanged.fire(this.projectPaths);
                }
                await this.refreshProject(normalized);
                this._onDidChangeEnvironments.fire();
                return;
            }
        }

        await this.refreshAll();
    }

    private async refreshAll(): Promise<void> {
        const oldPaths = new Set(this.projectPaths);
        this.projectPaths = await resolvePixiProjectPaths();
        await this.updateHasPixiProjectContext();

        const currentPaths = new Set(this.projectPaths);
        const pathsChanged = oldPaths.size !== currentPaths.size || [...oldPaths].some((p) => !currentPaths.has(p));

        if (pathsChanged) {
            this._onDidProjectsChanged.fire(this.projectPaths);
        }

        // Clean up deleted projects
        for (const knownPath of this.projectToEnvs.keys()) {
            if (!currentPaths.has(knownPath)) {
                this.projectToEnvs.delete(knownPath);
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
                    const platformNames = (rawEnv.platforms || []).map((p) => (typeof p === 'string' ? p : p.name));
                    const isDeclaredForHost =
                        !currentPlatform ||
                        (rawEnv.platforms || []).length === 0 ||
                        Boolean(rawEnv.resolved_platform) ||
                        (rawEnv.platforms || []).some((p) =>
                            typeof p === 'string'
                                ? p === currentPlatform
                                : p.subdir === currentPlatform || p.name === currentPlatform,
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
            const normalized = path.normalize(projectPath);
            const envs = this.getEnvironmentsForProject(normalized);
            const uninstalledEnvs = envs.filter((e) => e.pixiStatus === 'uninstalled');

            if (uninstalledEnvs.length === 0) {
                this.promptedAutoInstallProjects.delete(normalized);
                continue;
            }

            if (this.promptedAutoInstallProjects.has(normalized)) {
                continue;
            }

            const config = workspace.getConfiguration('pixi', Uri.file(normalized));
            const policy = config.get<'prompt' | 'always' | 'never'>('autoInstallOnOpen', 'prompt');
            if (policy === 'never') {
                continue;
            }

            this.promptedAutoInstallProjects.add(normalized);
            const projectName = envs[0]?.projectName || path.basename(normalized);

            if (policy === 'always') {
                traceVerbose(`Auto-installing environments for '${projectName}' (${normalized})`);
                await commands.executeCommand('pixi.install', Uri.file(normalized));
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
                            await commands.executeCommand('pixi.install', Uri.file(normalized));
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
        this.packagesInFlight.clear();
        this.projectToEnvs.clear();
        Disposable.from(...this.disposables).dispose();
    }
}
