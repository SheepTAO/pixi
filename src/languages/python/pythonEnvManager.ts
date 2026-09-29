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

import { PixiExtensionApi } from '../../api';
import { getPixi } from '../../cli/pixiCli';
import { createDeferred, Deferred } from '../../common/deferred';
import { traceVerbose } from '../../common/logging';
import { getWorkspacePersistentState } from '../../common/persistentState';
import { getDefaultEnvironment, matchEnvironmentForUri } from '../../core/environmentRules';
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
        private readonly pixiApi?: PixiExtensionApi,
        public readonly log?: LogOutputChannel,
    ) {
        // When PixiProjectManager refreshes or projects change, refresh Python environments
        this.disposables.push(
            this.projectManager.onDidChangeEnvironments(async () => {
                await this.refreshFromCore();
            }),
        );

        if (this.pixiApi) {
            this.disposables.push(
                this.pixiApi.onDidChangeActiveEnvironment(async (e) => {
                    if (e.environment) {
                        const project = e.scope ? this.api.getPythonProject(e.scope) : undefined;
                        const projectPath = project?.uri.fsPath || e.environment.projectPath;
                        const envs = this.projectToEnvs.get(projectPath) || [];
                        const pyEnv = envs.find((p) => p.pixiEnvName === e.environment?.pixiEnvName);
                        if (pyEnv && this.activeEnv.get(projectPath)?.envId.id !== pyEnv.envId.id) {
                            const oldEnv = this.activeEnv.get(projectPath);
                            this.activeEnv.set(projectPath, pyEnv);
                            this.triggerDidChangeEnvironment(Uri.file(projectPath), oldEnv, pyEnv);
                        }
                        if (e.scope === undefined && pyEnv && this.globalEnv?.envId.id !== pyEnv.envId.id) {
                            const oldGlobal = this.globalEnv;
                            this.globalEnv = pyEnv;
                            this.triggerDidChangeEnvironment(undefined, oldGlobal, pyEnv);
                        }
                    } else {
                        if (e.scope) {
                            const project = this.api.getPythonProject(e.scope);
                            const projectPath =
                                project?.uri.fsPath || (e.scope instanceof Uri ? e.scope.fsPath : undefined);
                            if (projectPath && this.activeEnv.has(projectPath)) {
                                const oldEnv = this.activeEnv.get(projectPath);
                                this.activeEnv.delete(projectPath);
                                this.triggerDidChangeEnvironment(Uri.file(projectPath), oldEnv, undefined);
                            }
                        } else {
                            if (this.globalEnv !== undefined) {
                                const oldGlobal = this.globalEnv;
                                this.globalEnv = undefined;
                                this.triggerDidChangeEnvironment(undefined, oldGlobal, undefined);
                            }
                        }
                    }
                }),
            );
        }

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

        // Restore active environments from persistent state or re-link existing instances
        const storage = await getWorkspacePersistentState();
        for (const [projectPath, envs] of this.projectToEnvs) {
            const currentActive = this.activeEnv.get(projectPath);
            const savedId = await storage.get<string>(`projectEnvId:${projectPath}`);
            const targetId = currentActive?.envId.id || savedId;
            if (targetId) {
                const found = envs.find((e) => e.envId.id === targetId);
                if (found) {
                    this.activeEnv.set(projectPath, found);
                } else if (!savedId) {
                    this.activeEnv.delete(projectPath);
                }
            }
        }
        for (const activePath of Array.from(this.activeEnv.keys())) {
            if (!this.projectToEnvs.has(activePath)) {
                this.activeEnv.delete(activePath);
            }
        }

        const globalTargetId = this.globalEnv?.envId.id || (await storage.get<string>('globalEnvId'));
        if (globalTargetId) {
            const allEnvs = Array.from(this.projectToEnvs.values()).flat();
            this.globalEnv = allEnvs.find((e) => e.envId.id === globalTargetId);
        }
    }

    private diffEnvironments(
        oldEnvs: PixiPythonEnvironment[],
        newEnvs: PixiPythonEnvironment[],
    ): DidChangeEnvironmentsEventArgs {
        const oldMap = new Map(oldEnvs.map((e) => [e.envId.id, e]));
        const newMap = new Map(newEnvs.map((e) => [e.envId.id, e]));

        const changes: DidChangeEnvironmentsEventArgs = [];

        for (const [id, oldEnv] of oldMap) {
            if (!newMap.has(id)) {
                changes.push({ environment: oldEnv, kind: EnvironmentChangeKind.remove });
            }
        }

        for (const [id, newEnv] of newMap) {
            const oldEnv = oldMap.get(id);
            if (!oldEnv) {
                changes.push({ environment: newEnv, kind: EnvironmentChangeKind.add });
            } else {
                const hasChanged =
                    oldEnv.pixiStatus !== newEnv.pixiStatus ||
                    oldEnv.version !== newEnv.version ||
                    oldEnv.displayName !== newEnv.displayName ||
                    oldEnv.execInfo?.run?.executable !== newEnv.execInfo?.run?.executable;
                if (hasChanged) {
                    changes.push(
                        { environment: oldEnv, kind: EnvironmentChangeKind.remove },
                        { environment: newEnv, kind: EnvironmentChangeKind.add },
                    );
                }
            }
        }

        return changes;
    }



    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all') {
            const all = Array.from(this.projectToEnvs.values()).flat();
            return sortEnvironments(all);
        }

        if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            const projectPath = project?.uri.fsPath || this.projectManager.findProjectForUri(scope);
            const envs = projectPath ? this.projectToEnvs.get(projectPath) || [] : [];
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
        const projectPath = project?.uri.fsPath || this.projectManager.findProjectForUri(scope);
        if (!projectPath) {
            return this.globalEnv;
        }

        const projectEnvs = this.projectToEnvs.get(projectPath) || [];
        const matched = matchEnvironmentForUri(scope, projectPath, projectEnvs);
        if (matched) {
            return matched;
        }

        const active = this.activeEnv.get(projectPath);
        if (active) {
            return active;
        }

        return getDefaultEnvironment(projectEnvs) || this.globalEnv;
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
            if (this.pixiApi && environment) {
                await this.pixiApi.setActiveEnvironment(undefined, (environment as PixiPythonEnvironment).pixiEnvName);
            }
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
                const pyEnv = environment as PixiPythonEnvironment;
                this.activeEnv.set(projectPath, pyEnv);
                await storage.set(`projectEnvId:${projectPath}`, environment.envId.id);
                if (this.pixiApi) {
                    await this.pixiApi.setActiveEnvironment(project.uri, pyEnv.pixiEnvName);
                }
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
