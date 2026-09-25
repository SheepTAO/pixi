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
import { Disposable, EventEmitter, LogOutputChannel, ThemeIcon, Uri, window, workspace } from 'vscode';

import { getPixi } from '../../cli/pixiCli';
import { createDeferred, Deferred } from '../../common/deferred';
import { traceVerbose } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { matchEnvironmentRule } from '../../core/environmentRules';
import { PixiProjectManager } from '../../core/projectManager';
import { PIXI_MANAGER_ID } from './constants';
import {
    createPythonEnvironment,
    isEnvironmentInvalid,
    promptToInstallEnvironment,
    sortEnvironments,
} from './pythonDiscovery';
import { PixiPythonEnvironment } from './types';

export class PixiPythonEnvManager implements EnvironmentManager, Disposable {
    public readonly name = 'pixi';
    public readonly displayName = 'Pixi';
    public readonly preferredPackageManagerId = PIXI_MANAGER_ID;
    public readonly tooltip = 'Pixi Environment Manager';
    public readonly iconPath: IconPath = new ThemeIcon('prefix-dev');

    private globalEnv: PixiPythonEnvironment | undefined;
    private activeEnv = new Map<string, PixiPythonEnvironment>();
    private projectToEnvs = new Map<string, PixiPythonEnvironment[]>();
    private readonly disposables: Disposable[] = [];

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    private _initialized: Deferred<void> | undefined;

    constructor(
        private readonly api: PythonEnvironmentApi,
        private readonly projectManager: PixiProjectManager,
        public readonly log?: LogOutputChannel,
    ) {
        // When PixiProjectManager refreshes or projects change, refresh Python environments
        this.disposables.push(
            this.projectManager.onDidChangeEnvironments(async () => {
                await this.refreshFromCore();
            }),
        );

        // Listen for configuration changes
        this.disposables.push(
            workspace.onDidChangeConfiguration(async (e) => {
                if (e.affectsConfiguration('pixi.displayNameFormat')) {
                    traceVerbose('pixi.displayNameFormat changed, refreshing environments');
                    await this.refresh(undefined);
                }
                if (e.affectsConfiguration('pixi.environmentRules')) {
                    traceVerbose('pixi.environmentRules changed, updating environments for visible editors');
                    for (const editor of window.visibleTextEditors) {
                        if (editor.document.languageId === 'python') {
                            const env = await this.get(editor.document.uri);
                            if (env) {
                                await this.set(editor.document.uri, env);
                            }
                        }
                    }
                }
            }),
        );
    }

    public async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }

        this._initialized = createDeferred<void>();
        try {
            await this.refreshFromCore();
        } finally {
            this._initialized.resolve();
        }
    }

    public dispose(): void {
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.globalEnv = undefined;
        this.activeEnv.clear();
        this.projectToEnvs.clear();
    }

    public getPixiEnvironment(envId: string): PixiPythonEnvironment | undefined {
        const normalized = path.normalize(envId);
        for (const envs of this.projectToEnvs.values()) {
            const found = envs.find((e) => path.normalize(e.envId.id) === normalized);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    public async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        await this.projectManager.refresh(scope instanceof Uri ? scope : undefined);
    }

    private async refreshFromCore(): Promise<void> {
        const oldProjectToEnvs = new Map(this.projectToEnvs);
        this.projectToEnvs.clear();

        const projectPaths = this.projectManager.getProjectPaths();
        const projects = this.api.getPythonProjects();
        const projectMap = new Map(projects.map((p) => [p.uri.fsPath, p]));

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

        let pixiBin = 'pixi';
        try {
            pixiBin = await getPixi();
        } catch {
            // fallback
        }

        const changes: DidChangeEnvironmentsEventArgs = [];

        await Promise.all(
            projectPaths.map(async (projectPath) => {
                const template =
                    workspace.getConfiguration('pixi', Uri.file(projectPath)).get<string>('displayNameFormat') ||
                    '${project}:${env}';

                const coreEnvs = this.projectManager.getEnvironmentsForProject(projectPath);
                const pyEnvs = await Promise.all(
                    coreEnvs.map((core) => createPythonEnvironment(core, pixiBin, template)),
                );

                const sorted = sortEnvironments(pyEnvs);
                this.projectToEnvs.set(projectPath, sorted);

                const oldEnvs = oldProjectToEnvs.get(projectPath) || [];
                changes.push(...this.diffEnvironments(oldEnvs, sorted));
            }),
        );

        // Handle deleted projects
        for (const [oldPath, oldEnvs] of oldProjectToEnvs) {
            if (!this.projectToEnvs.has(oldPath) && oldEnvs.length > 0) {
                changes.push(...this.diffEnvironments(oldEnvs, []));
            }
        }

        if (changes.length > 0) {
            this._onDidChangeEnvironments.fire(changes);
        }

        // Restore active environments from persistent state
        const storage = await getWorkspacePersistentState();
        for (const [projectPath, envs] of this.projectToEnvs) {
            const savedId = await storage.get<string>(`projectEnvId:${projectPath}`);
            if (savedId) {
                const found = envs.find((e) => e.envId.id === savedId);
                if (found) {
                    this.activeEnv.set(projectPath, found);
                }
            }
        }
        const globalSavedId = await storage.get<string>('globalEnvId');
        if (globalSavedId) {
            const allEnvs = Array.from(this.projectToEnvs.values()).flat();
            this.globalEnv = allEnvs.find((e) => e.envId.id === globalSavedId);
        }
    }

    private diffEnvironments(
        oldEnvs: PixiPythonEnvironment[],
        newEnvs: PixiPythonEnvironment[],
    ): DidChangeEnvironmentsEventArgs {
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

    private getDefaultProjectEnv(envs: PixiPythonEnvironment[]): PixiPythonEnvironment | undefined {
        const installedEnvs = envs.filter((e) => e.pixiStatus === 'installed' || (!e.pixiStatus && !e.error));
        const uninstalledEnvs = envs.filter(
            (e) => e.pixiStatus === 'uninstalled' || (e.error && e.error.includes('not installed')),
        );
        return (
            installedEnvs.find((e) => e.pixiEnvName === 'default') ||
            installedEnvs[0] ||
            uninstalledEnvs.find((e) => e.pixiEnvName === 'default') ||
            uninstalledEnvs[0] ||
            envs.find((e) => e.pixiEnvName === 'default') ||
            envs[0]
        );
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all') {
            const all = Array.from(this.projectToEnvs.values()).flat();
            return sortEnvironments(all);
        }

        if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            const envs = project ? this.projectToEnvs.get(project.uri.fsPath) || [] : [];
            return sortEnvironments(envs);
        }

        return [];
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
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
                    .getConfiguration('pixi', scope)
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

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        if (environment) {
            const pyEnv = environment as PixiPythonEnvironment;
            if (pyEnv.pixiStatus === 'uninstalled') {
                const targetFolder = scope instanceof Uri ? scope : Array.isArray(scope) ? scope[0] : undefined;
                void promptToInstallEnvironment(pyEnv, targetFolder);
                return;
            }

            if (isEnvironmentInvalid(pyEnv)) {
                const reason =
                    pyEnv.statusReason ||
                    environment.error ||
                    'The environment is incompatible with the current platform or missing Python.';
                void window.showErrorMessage(`Cannot activate environment '${environment.displayName}': ${reason}`);
                return;
            }
        }

        const storage = await getWorkspacePersistentState();

        if (scope === undefined) {
            await storage.set('globalEnvId', environment?.envId.id);
            this.triggerDidChangeEnvironment(undefined, this.globalEnv, environment);
            this.globalEnv = environment as PixiPythonEnvironment | undefined;
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
                this.activeEnv.set(projectPath, environment as PixiPythonEnvironment);
                await storage.set(`projectEnvId:${projectPath}`, environment.envId.id);
            } else {
                this.activeEnv.delete(projectPath);
                await storage.set(`projectEnvId:${projectPath}`, undefined);
            }

            this.triggerDidChangeEnvironment(project.uri, oldEnv, environment);
        }
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return this.get(context);
    }

    private triggerDidChangeEnvironment(
        uri: Uri | undefined,
        oldEnv: PythonEnvironment | undefined,
        newEnv: PythonEnvironment | undefined,
    ): void {
        this._onDidChangeEnvironment.fire({
            uri,
            old: oldEnv,
            new: newEnv,
        });
    }
}
