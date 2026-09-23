import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '@vscode/python-environments';
import * as path from 'path';
import {
    commands,
    Disposable,
    EventEmitter,
    LogOutputChannel,
    MarkdownString,
    ProgressLocation,
    ThemeIcon,
    Uri,
    window,
    workspace,
} from 'vscode';

import { createDeferred, Deferred } from '../common/deferred';
import { traceVerbose } from '../common/logging';
import { getWorkspacePersistentState } from '../common/persistentState';
import { resolvePixiProjectPaths } from '../common/searchPaths';
import { PIXI_MANAGER_ID } from '../common/utils';
import { isPixiProject, refreshPixi, sortEnvironments } from './discovery';
import { matchEnvironmentRule } from './ruleMatcher';
import { PixiEnvironment } from './types';

export class PixiEnvManager implements EnvironmentManager, Disposable {
    private globalEnv: PythonEnvironment | undefined;
    private activeEnv = new Map<string, PythonEnvironment>(); // Selected environment for each project
    private projectToEnvs = new Map<string, PixiEnvironment[]>(); // Maps a project path to its `pixi info` output
    private readonly disposables: Disposable[] = [];

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    constructor(
        private readonly api: PythonEnvironmentApi,
        public readonly log: LogOutputChannel,
    ) {
        this.name = 'pixi';
        this.displayName = 'Pixi';
        this.preferredPackageManagerId = PIXI_MANAGER_ID;
        this.tooltip = 'Pixi Environment Manager';
        this.iconPath = new ThemeIcon('prefix-dev');

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

                // Determine target scope: if all changes belong to a single project, refresh only that project
                let targetScope: Uri | undefined = undefined;
                if (uris.length > 0) {
                    const projectUris = new Set<string>();
                    for (const u of uris) {
                        const proj = this.api.getPythonProject(u);
                        if (proj) {
                            projectUris.add(proj.uri.fsPath);
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
                    `Manifest/lock changed, triggering debounced refresh (targetScope: ${targetScope?.fsPath ?? 'all'})`,
                );
                await this.refresh(targetScope);
            }, 500);
        };

        const watcher = workspace.createFileSystemWatcher('**/{pixi.toml,pixi.lock,pyproject.toml}');
        watcher.onDidChange((uri) => scheduleRefresh(uri), this, this.disposables);
        watcher.onDidCreate((uri) => scheduleRefresh(uri), this, this.disposables);
        watcher.onDidDelete((uri) => scheduleRefresh(uri), this, this.disposables);
        this.disposables.push(watcher);
        this.disposables.push({
            dispose: () => {
                if (refreshTimer) {
                    clearTimeout(refreshTimer);
                }
            },
        });

        // Watch configuration changes
        this.disposables.push(
            workspace.onDidChangeConfiguration(async (e) => {
                if (e.affectsConfiguration('pixi-python.displayNameFormat')) {
                    traceVerbose('pixi-python.displayNameFormat changed, refreshing environments');
                    await this.refresh(undefined);
                }
                if (e.affectsConfiguration('pixi-python.environmentRules')) {
                    traceVerbose('pixi-python.environmentRules changed, updating environments for visible editors');
                    for (const editor of window.visibleTextEditors) {
                        if (editor.document.languageId === 'python') {
                            const env = await this.get(editor.document.uri);
                            this._onDidChangeEnvironment.fire({ uri: editor.document.uri, old: undefined, new: env });
                        }
                    }
                }
            }),
        );
    }

    readonly name: string;
    readonly displayName: string;
    readonly preferredPackageManagerId: string;
    readonly description?: string;
    readonly tooltip: string | MarkdownString;
    readonly iconPath?: IconPath;

    dispose() {
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.globalEnv = undefined;
        this.activeEnv.clear();
        this.projectToEnvs.clear();
    }

    private _initialized: Deferred<void> | undefined;

    async initialize() {
        if (this._initialized) {
            return this._initialized.promise;
        }

        this._initialized = createDeferred();

        try {
            await this.refreshAll();
        } finally {
            this._initialized.resolve();
        }
    }

    private isRefreshing = false;
    private hasPendingRefresh = false;
    private pendingRefreshScope: RefreshEnvironmentsScope = undefined;

    async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        traceVerbose(`Called refresh with scope: ${scope}`);

        if (this.isRefreshing) {
            // Coalesce pending refreshes: if different projects or full refresh, fallback to all (undefined)
            if (this.hasPendingRefresh) {
                if (
                    this.pendingRefreshScope instanceof Uri &&
                    scope instanceof Uri &&
                    this.pendingRefreshScope.fsPath === scope.fsPath
                ) {
                    // Same target project, keep targeted scope
                } else {
                    this.pendingRefreshScope = undefined;
                }
            } else {
                this.pendingRefreshScope = scope;
                this.hasPendingRefresh = true;
            }
            return;
        }

        this.isRefreshing = true;
        try {
            if (scope instanceof Uri) {
                await this.refreshOne(scope);
            } else {
                await this.refreshAll();
            }
        } finally {
            this.isRefreshing = false;
            if (this.hasPendingRefresh) {
                const nextScope = this.pendingRefreshScope;
                this.hasPendingRefresh = false;
                this.pendingRefreshScope = undefined;
                await this.refresh(nextScope);
            }
        }
    }

    getDefaultProjectEnv(envs: PixiEnvironment[]): PixiEnvironment | undefined {
        const healthyEnvs = envs.filter((e) => !e.error);
        const cacheEnvs = envs.filter(
            (e) => e.pixiStatus === 'cache' || (e.error && e.error.includes('not installed')),
        );
        return (
            healthyEnvs.find((e) => e.pixiEnvName === 'default') ||
            healthyEnvs[0] ||
            cacheEnvs.find((e) => e.pixiEnvName === 'default') ||
            cacheEnvs[0] ||
            envs.find((e) => e.pixiEnvName === 'default') ||
            envs[0]
        );
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        traceVerbose(`Called getEnvironments with scope: ${scope}`);

        await this.initialize();

        if (scope === 'all') {
            return sortEnvironments([...this.buildEnvLookup().values()]);
        }

        if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            const envs = project ? this.projectToEnvs.get(project.uri.fsPath) || [] : [];
            return sortEnvironments([...envs]);
        }

        return [];
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        traceVerbose(`Called get with scope: ${scope}`);

        await this.initialize();

        if (!scope) {
            return this.globalEnv;
        }

        const project = this.api.getPythonProject(scope);
        if (!project) {
            return this.globalEnv;
        }

        if (scope.scheme === 'file') {
            const relPath = path.relative(project.uri.fsPath, scope.fsPath).replace(/\\/g, '/');
            if (!relPath.startsWith('..')) {
                const rules = workspace
                    .getConfiguration('pixi-python', scope)
                    .get<string[] | Record<string, string>>('environmentRules');
                if (rules) {
                    const matched = matchEnvironmentRule(
                        rules,
                        relPath,
                        this.projectToEnvs.get(project.uri.fsPath) || [],
                    );
                    if (matched) {
                        return matched;
                    }
                }
            }
        }

        const active = this.activeEnv.get(project.uri.fsPath);
        if (active) {
            return active;
        }

        const projectEnvs = this.projectToEnvs.get(project.uri.fsPath) || [];
        return this.getDefaultProjectEnv(projectEnvs) || this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment) {
        traceVerbose(`Called set with scope: ${scope}, environment: ${JSON.stringify(environment)}`);

        if (environment?.error) {
            const pixiEnv = environment as PixiEnvironment;
            const isUninstalled = pixiEnv.pixiStatus === 'cache' || environment.error.includes('not installed');
            const msg = `Cannot activate environment '${environment.displayName}': ${environment.error}`;
            if (isUninstalled) {
                void window
                    .showWarningMessage(
                        `Environment '${pixiEnv.pixiEnvName}' is not installed yet on disk. Would you like to install it now?`,
                        'Install Environment',
                    )
                    .then((action) => {
                        if (action === 'Install Environment') {
                            const manifestPath = pixiEnv.pixiInfo?.project_info?.manifest_path;
                            const projectFolder = manifestPath ? Uri.file(path.dirname(manifestPath)) : undefined;
                            const targetFolder =
                                (scope instanceof Uri ? scope : Array.isArray(scope) ? scope[0] : undefined) ??
                                projectFolder ??
                                pixiEnv.environmentPath;
                            void commands.executeCommand('pixi-python.install', targetFolder, pixiEnv.pixiEnvName);
                        }
                    });
            } else {
                void window.showErrorMessage(msg);
            }
            return;
        }

        if (scope === undefined) {
            await setGlobalEnvId(environment?.envId.id);
            this.triggerDidChangeEnvironment(undefined, this.globalEnv, environment);
            this.globalEnv = environment;
            return;
        }

        const uris = scope instanceof Uri ? [scope] : scope;

        for (const uri of uris) {
            const project = this.api.getPythonProject(uri);
            if (!project) {
                continue;
            }

            const projectPath = project.uri.fsPath;
            const oldEnv = this.activeEnv.get(projectPath);

            if (environment) {
                this.activeEnv.set(projectPath, environment);
            } else {
                this.activeEnv.delete(projectPath);
            }

            await setProjectEnvId(projectPath, environment?.envId.id);
            this.triggerDidChangeEnvironment(project.uri, oldEnv, environment);
        }
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        traceVerbose(`Called resolve with context: ${context}`);

        return this.get(context);
    }

    async clearCache() {
        traceVerbose('Called clearCache');

        await clearExtensionCache();
    }

    getPixiEnvironment(envId: string): PixiEnvironment | undefined {
        const normalized = path.normalize(envId);
        for (const envs of this.projectToEnvs.values()) {
            const found = envs.find((e) => path.normalize(e.envId.id) === normalized);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    getProjectPaths(): string[] {
        return Array.from(this.projectToEnvs.keys());
    }

    getEnvironmentsForProject(projectPath: string): PixiEnvironment[] {
        return this.projectToEnvs.get(projectPath) || [];
    }

    private buildEnvLookup(): Map<string, PixiEnvironment> {
        return new Map(
            Array.from(this.projectToEnvs.values()).flatMap((envs) => envs.map((env) => [env.envId.id, env])),
        );
    }

    private diffEnvironments(oldEnvs: PixiEnvironment[], newEnvs: PixiEnvironment[]): DidChangeEnvironmentsEventArgs {
        const oldIds = new Set(oldEnvs.map((e) => e.envId.id));
        const newIds = new Set(newEnvs.map((e) => e.envId.id));

        return [
            ...oldEnvs
                .filter((e) => !newIds.has(e.envId.id))
                .map((e) => ({ environment: e, kind: EnvironmentChangeKind.remove })),
            ...newEnvs
                .filter((e) => !oldIds.has(e.envId.id))
                .map((e) => ({ environment: e, kind: EnvironmentChangeKind.add })),
        ];
    }

    private async refreshAll(): Promise<void> {
        const oldProjectToEnvs = new Map(this.projectToEnvs);
        this.projectToEnvs.clear();

        // Collect project paths from registered Python projects and search paths
        const projects = this.api.getPythonProjects();
        const projectMap = new Map(projects.map((p) => [p.uri.fsPath, p]));

        const searchPathRoots = await resolvePixiProjectPaths();
        const allCandidatePaths = new Set([...projectMap.keys(), ...searchPathRoots]);
        const projectPaths = [...allCandidatePaths].filter((p) => isPixiProject(p));

        const newProjects: PythonProject[] = [];
        for (const projectPath of projectPaths) {
            if (!projectMap.has(projectPath)) {
                const proj: PythonProject = {
                    name: path.basename(projectPath),
                    uri: Uri.file(projectPath),
                };
                newProjects.push(proj);
                projectMap.set(projectPath, proj);
            }
        }
        if (newProjects.length > 0) {
            this.api.addPythonProject(newProjects);
        }

        const hasPixi = projectPaths.length > 0;
        await commands.executeCommand('setContext', 'pixi-python.hasPixiProject', hasPixi);

        if (!hasPixi) {
            const allOld = Array.from(oldProjectToEnvs.values()).flat();
            if (allOld.length > 0) {
                this._onDidChangeEnvironments.fire(this.diffEnvironments(allOld, []));
            }
            return;
        }

        await window.withProgress(
            {
                location: ProgressLocation.Window,
                title: 'Discovering Pixi environments',
            },
            async () => {
                const changes: DidChangeEnvironmentsEventArgs = [];

                await Promise.all(
                    projectPaths.map(async (projectPath) => {
                        const oldEnvs = oldProjectToEnvs.get(projectPath) || [];
                        const newEnvs = await refreshPixi(projectPath);

                        changes.push(...this.diffEnvironments(oldEnvs, newEnvs));
                        this.projectToEnvs.set(projectPath, newEnvs);
                    }),
                );

                this._onDidChangeEnvironments.fire(changes);

                const envLookup = this.buildEnvLookup();

                // Update global environment
                const globalEnvId = await getGlobalEnvId();
                const globalEnv = globalEnvId ? envLookup.get(globalEnvId) : undefined;
                this.triggerDidChangeEnvironment(undefined, this.globalEnv, globalEnv);
                this.globalEnv = globalEnv;

                // Update active environments for each project
                const oldActiveEnv = new Map(this.activeEnv);
                this.activeEnv.clear();

                for (const projectPath of projectPaths) {
                    const envId = await getProjectEnvId(projectPath);
                    let env = envId ? envLookup.get(envId) : undefined;
                    if (!env || env.error) {
                        const projectEnvs = this.projectToEnvs.get(projectPath) || [];
                        const candidate = this.getDefaultProjectEnv(projectEnvs);
                        if (!env || (candidate && !candidate.error)) {
                            env = candidate;
                        }
                    }

                    if (env) {
                        this.activeEnv.set(projectPath, env);
                    }

                    this.triggerDidChangeEnvironment(
                        projectMap.get(projectPath)?.uri,
                        oldActiveEnv.get(projectPath),
                        env,
                    );
                }
            },
        );
    }

    private async refreshOne(scope: Uri): Promise<void> {
        let project = this.api.getPythonProject(scope);
        const projectPath = project ? project.uri.fsPath : scope.fsPath;
        if (!isPixiProject(projectPath)) {
            return;
        }

        if (!project) {
            project = {
                name: path.basename(projectPath),
                uri: Uri.file(projectPath),
            };
            this.api.addPythonProject(project);
        }

        const oldEnvs = this.projectToEnvs.get(projectPath) || [];
        const newEnvs = await refreshPixi(projectPath);

        this.projectToEnvs.set(projectPath, newEnvs);
        this._onDidChangeEnvironments.fire(this.diffEnvironments(oldEnvs, newEnvs));

        // Update active environment for this project
        const envId = await getProjectEnvId(projectPath);
        let env = envId ? newEnvs.find((e) => e.envId.id === envId) : undefined;
        if (!env || env.error) {
            const candidate = this.getDefaultProjectEnv(newEnvs);
            if (!env || (candidate && !candidate.error)) {
                env = candidate;
            }
        }
        this.triggerDidChangeEnvironment(project.uri, this.activeEnv.get(projectPath), env);

        if (env) {
            this.activeEnv.set(projectPath, env);
        } else {
            this.activeEnv.delete(projectPath);
        }
    }

    private triggerDidChangeEnvironment(
        uri: Uri | undefined,
        oldEnv: PythonEnvironment | undefined,
        newEnv: PythonEnvironment | undefined,
    ) {
        if (oldEnv?.envId.id !== newEnv?.envId.id) {
            this._onDidChangeEnvironment.fire({ uri, old: oldEnv, new: newEnv });
        }
    }
}

const PIXI_WORKSPACE_KEY = `${PIXI_MANAGER_ID}:WORKSPACE_SELECTED`;
const PIXI_GLOBAL_KEY = `${PIXI_MANAGER_ID}:GLOBAL_SELECTED`;
const PIXI_DONT_ASK_INSTALL_KEY = `${PIXI_MANAGER_ID}:DONT_ASK_INSTALL`;

type PixiPersistentState = {
    [projectPath: string]: string;
};

async function clearExtensionCache(): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.clear([PIXI_WORKSPACE_KEY, PIXI_GLOBAL_KEY, PIXI_DONT_ASK_INSTALL_KEY]);
}

async function getGlobalEnvId(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return state.get(PIXI_GLOBAL_KEY);
}

async function setGlobalEnvId(envId: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.set(PIXI_GLOBAL_KEY, envId);
}

async function getProjectEnvId(projectPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: PixiPersistentState = (await state.get(PIXI_WORKSPACE_KEY)) ?? {};
    return data[projectPath];
}

async function setProjectEnvId(projectPath: string, envId: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: PixiPersistentState = (await state.get(PIXI_WORKSPACE_KEY)) ?? {};
    if (envId) {
        data[projectPath] = envId;
    } else {
        delete data[projectPath];
    }
    await state.set(PIXI_WORKSPACE_KEY, data);
}
