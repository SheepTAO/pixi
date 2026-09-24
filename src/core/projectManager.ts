import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, EventEmitter, LogOutputChannel, ProgressLocation, Uri, window, workspace } from 'vscode';

import { traceError, traceVerbose } from '../common/logging';
import { runPixi } from './cli';
import { matchEnvironmentRule } from './environmentRules';
import { listPixiPackages, PixiPackage } from './packageManager';
import { isPixiProject, resolvePixiProjectPaths } from './projectDiscovery';
import { scanEnvironmentToolchains } from './toolchains';
import { PixiEnvironmentInfo, PixiEnvironmentStatus, PixiInfo, PixiProject } from './types';

export class PixiProjectManager implements Disposable {
    private projectPaths: string[] = [];
    private projectToEnvs = new Map<string, PixiEnvironmentInfo[]>();
    private packagesCache = new Map<string, PixiPackage[]>();
    private readonly disposables: Disposable[] = [];

    private readonly _onDidProjectsChanged = new EventEmitter<string[]>();
    readonly onDidProjectsChanged = this._onDidProjectsChanged.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<void>();
    readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    constructor(public readonly log?: LogOutputChannel) {
        // Watch manifest and lock files for changes (debounced by 500ms with project targeting)
        let refreshTimer: NodeJS.Timeout | undefined;
        let pendingChangedUris: Uri[] = [];

        const scheduleRefresh = (uri?: Uri) => {
            if (uri) {
                pendingChangedUris.push(uri);
            }
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            refreshTimer = setTimeout(async () => {
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

        const pixiWatcher = workspace.createFileSystemWatcher('**/pixi.toml');
        const pyprojectWatcher = workspace.createFileSystemWatcher('**/pyproject.toml');
        const lockWatcher = workspace.createFileSystemWatcher('**/pixi.lock');

        this.disposables.push(
            pixiWatcher,
            pixiWatcher.onDidChange(scheduleRefresh),
            pixiWatcher.onDidCreate(scheduleRefresh),
            pixiWatcher.onDidDelete(scheduleRefresh),
            pyprojectWatcher,
            pyprojectWatcher.onDidChange(scheduleRefresh),
            pyprojectWatcher.onDidCreate(scheduleRefresh),
            pyprojectWatcher.onDidDelete(scheduleRefresh),
            lockWatcher,
            lockWatcher.onDidChange(scheduleRefresh),
            lockWatcher.onDidCreate(scheduleRefresh),
            lockWatcher.onDidDelete(scheduleRefresh),
        );
    }

    public async initialize(): Promise<void> {
        this.projectPaths = await resolvePixiProjectPaths();
        await this.updateHasPixiProjectContext();
        await this.refreshAll();
    }

    public getProjectPaths(): string[] {
        return [...this.projectPaths];
    }

    public getProjects(): PixiProject[] {
        return this.projectPaths.map((p) => {
            const envs = this.projectToEnvs.get(path.normalize(p));
            if (envs && envs.length > 0) {
                return {
                    name: envs[0].projectName,
                    projectPath: p,
                    manifestPath: envs[0].manifestPath,
                };
            }
            const pixiToml = path.join(p, 'pixi.toml');
            const pyprojectToml = path.join(p, 'pyproject.toml');
            const manifestPath = fs.existsSync(pixiToml)
                ? pixiToml
                : fs.existsSync(pyprojectToml)
                  ? pyprojectToml
                  : pixiToml;
            return {
                name: path.basename(p),
                projectPath: p,
                manifestPath,
            };
        });
    }

    public getEnvironmentsForProject(projectPath: string): PixiEnvironmentInfo[] {
        const normalized = path.normalize(projectPath);
        return this.projectToEnvs.get(normalized) || [];
    }

    public getAllEnvironments(): PixiEnvironmentInfo[] {
        const result: PixiEnvironmentInfo[] = [];
        for (const envs of this.projectToEnvs.values()) {
            result.push(...envs);
        }
        return result;
    }

    public clearPackagesCache(projectPath?: string): void {
        if (projectPath) {
            const normalized = path.normalize(projectPath);
            for (const key of this.packagesCache.keys()) {
                if (key.startsWith(normalized + ':')) {
                    this.packagesCache.delete(key);
                }
            }
        } else {
            this.packagesCache.clear();
        }
    }

    public async getPackagesForEnvironment(envName: string, projectPath: string): Promise<PixiPackage[]> {
        const cacheKey = `${path.normalize(projectPath)}:${envName}`;
        if (this.packagesCache.has(cacheKey)) {
            return this.packagesCache.get(cacheKey)!;
        }

        try {
            const pkgs = await listPixiPackages(envName, projectPath);
            this.packagesCache.set(cacheKey, pkgs);
            traceVerbose(`Loaded ${pkgs.length} packages for environment '${envName}' in ${projectPath}`);
            return pkgs;
        } catch (error) {
            traceError(`Failed to fetch packages for environment '${envName}':`, error);
            return [];
        }
    }

    public findProjectForUri(uri: Uri): string | undefined {
        const filePath = path.normalize(uri.fsPath);
        for (const projectPath of this.projectPaths) {
            if (filePath === projectPath || filePath.startsWith(projectPath + path.sep)) {
                return projectPath;
            }
        }
        if (isPixiProject(filePath)) {
            return filePath;
        }
        const dir = path.dirname(filePath);
        if (isPixiProject(dir)) {
            return dir;
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

        if (uri.scheme === 'file') {
            const relPath = path.relative(projectPath, uri.fsPath).replace(/\\/g, '/');
            if (!relPath.startsWith('..')) {
                const rules = workspace
                    .getConfiguration('pixi', uri)
                    .get<string[] | Record<string, string>>('environmentRules');
                if (rules) {
                    const matched = matchEnvironmentRule(rules, relPath, envs);
                    if (matched) {
                        return matched;
                    }
                }
            }
        }

        return (
            envs.find((e) => e.pixiEnvName === 'default' && e.pixiStatus === 'installed') ||
            envs.find((e) => e.pixiStatus === 'installed') ||
            envs.find((e) => e.pixiEnvName === 'default') ||
            envs[0]
        );
    }

    public async refresh(scope?: Uri): Promise<void> {
        if (scope) {
            const projectPath = this.findProjectForUri(scope);
            if (projectPath) {
                await this.refreshProject(projectPath);
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
        this.clearPackagesCache(projectPath);
        try {
            const stdout = await runPixi(['info', '--json'], { cwd: projectPath });
            const pixiInfo: PixiInfo = JSON.parse(stdout);

            if (!pixiInfo.project_info) {
                traceVerbose(`No project_info returned from pixi info for ${projectPath}`);
                this.projectToEnvs.set(projectPath, []);
                return;
            }

            const projectName = pixiInfo.project_info.name;
            const manifestPath = pixiInfo.project_info.manifest_path;
            const currentPlatform = pixiInfo.platform;

            const envs: PixiEnvironmentInfo[] = await Promise.all(
                pixiInfo.environments_info.map(async (rawEnv) => {
                    const platformNames = (rawEnv.platforms || []).map((p) => (typeof p === 'string' ? p : p.name));
                    const isPlatformSupported =
                        !currentPlatform || platformNames.length === 0 || platformNames.includes(currentPlatform);

                    let status: PixiEnvironmentStatus = 'installed';
                    let statusReason: string | undefined;

                    if (!isPlatformSupported) {
                        status = 'incompatible';
                        statusReason = `Environment '${rawEnv.name}' declared platforms [${platformNames.join(', ')}], which is incompatible with host platform '${currentPlatform}'.`;
                    } else if (!fs.existsSync(rawEnv.prefix)) {
                        status = 'uninstalled';
                        statusReason = `Environment '${rawEnv.name}' is not installed on disk. Run 'pixi install -e ${rawEnv.name}' to create it.`;
                    }

                    const envInfo: PixiEnvironmentInfo = {
                        pixiEnvName: rawEnv.name,
                        prefix: rawEnv.prefix,
                        projectPath,
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

            this.projectToEnvs.set(projectPath, envs);
        } catch (error) {
            traceError(`Failed to refresh Pixi project at ${projectPath}:`, error);
            this.projectToEnvs.set(projectPath, []);
        }
    }

    private async updateHasPixiProjectContext(): Promise<void> {
        const hasPixi = this.projectPaths.length > 0;
        await commands.executeCommand('setContext', 'pixi.hasPixiProject', hasPixi);
    }

    public dispose(): void {
        this._onDidProjectsChanged.dispose();
        this._onDidChangeEnvironments.dispose();
        Disposable.from(...this.disposables).dispose();
    }
}
