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
import { Disposable, EventEmitter, ThemeIcon, Uri, window, workspace } from 'vscode';

import { PixiExtensionApi } from '../../api';
import { getPixi } from '../../cli/pixiCli';
import { traceVerbose } from '../../common/logging';
import { getProjectEnvStorageKey, getWorkspacePersistentState, GLOBAL_ENV_KEY } from '../../common/persistentState';
import {
    ensureEnvironmentReady,
    getDefaultEnvironment,
    matchEnvironmentForUri,
    sortPixiEnvironments,
} from '../../core/environmentRules';
import { getProjectKey } from '../../core/projectDiscovery';
import { PixiProjectManager } from '../../core/projectManager';
import { PIXI_MANAGER_ID } from './constants';
import { createPythonEnvironment, promptToInstallIpykernel } from './pythonDiscovery';
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

    private initPromise?: Promise<void>;

    constructor(
        private readonly api: PythonEnvironmentApi,
        private readonly projectManager: PixiProjectManager,
        private readonly pixiApi: PixiExtensionApi,
    ) {
        // When PixiProjectManager refreshes, projects change, or configuration changes, update Python environments
        this.disposables.push(
            this.projectManager.onDidChangeEnvironments(async () => {
                await this.refreshFromCore();
            }),
            this.pixiApi.onDidChangeActiveEnvironment((e) => {
                if (e.environment) {
                    const project = e.scope ? this.api.getPythonProject(e.scope) : undefined;
                    const projectPath = project?.uri.fsPath || e.environment.projectPath;
                    const envs = this.projectToEnvs.get(getProjectKey(projectPath)) || [];
                    const pyEnv = envs.find((p) => p.pixiEnvName === e.environment?.pixiEnvName);
                    if (pyEnv) {
                        this.updateProjectActiveEnv(projectPath, pyEnv);
                        if (e.scope === undefined) {
                            this.updateGlobalActiveEnv(pyEnv);
                        }
                    }
                } else if (e.scope) {
                    const project = this.api.getPythonProject(e.scope);
                    const projectPath = project?.uri.fsPath || e.scope.fsPath;
                    this.updateProjectActiveEnv(projectPath, undefined);
                } else {
                    this.updateGlobalActiveEnv(undefined);
                }
            }),
            workspace.onDidChangeConfiguration(async (e) => {
                if (e.affectsConfiguration('pixi.displayNameFormat')) {
                    traceVerbose('pixi.displayNameFormat changed, refreshing environments');
                    await this.refreshFromCore();
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

    public initialize(): Promise<void> {
        return (this.initPromise ??= this.refreshFromCore());
    }

    public dispose(): void {
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
        Disposable.from(...this.disposables).dispose();
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
                    name: this.projectManager.getProjectName(projectPath),
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

        for (const projectPath of projectPaths) {
            const template =
                workspace.getConfiguration('pixi', Uri.file(projectPath)).get<string>('displayNameFormat') ||
                '${project}:${env}';

            const coreEnvs = this.projectManager.getEnvironmentsForProject(projectPath);
            const pyEnvs = coreEnvs.map((core) => createPythonEnvironment(core, pixiBin, template));

            const sorted = sortPixiEnvironments(pyEnvs);
            const key = getProjectKey(projectPath);
            this.projectToEnvs.set(key, sorted);

            const oldEnvs = oldProjectToEnvs.get(key) || [];
            changes.push(...this.diffEnvironments(oldEnvs, sorted));
        }

        // Handle deleted projects
        for (const [oldKey, oldEnvs] of oldProjectToEnvs) {
            if (!this.projectToEnvs.has(oldKey)) {
                this.activeEnv.delete(oldKey);
                if (oldEnvs.length > 0) {
                    changes.push(...this.diffEnvironments(oldEnvs, []));
                }
            }
        }

        // Restore active environments from persistent state or re-link existing instances
        const storage = getWorkspacePersistentState();
        for (const [key, envs] of this.projectToEnvs) {
            const projectPath = envs[0]?.projectPath;
            const targetName =
                this.activeEnv.get(key)?.pixiEnvName ||
                (projectPath ? storage.get<string>(getProjectEnvStorageKey(projectPath)) : undefined);
            const found = targetName ? envs.find((e) => e.pixiEnvName === targetName) : undefined;
            if (found) {
                this.activeEnv.set(key, found);
            } else {
                this.activeEnv.delete(key);
            }
        }

        const globalTargetName = this.globalEnv?.pixiEnvName || storage.get<string>(GLOBAL_ENV_KEY);
        if (globalTargetName) {
            const allEnvs = Array.from(this.projectToEnvs.values()).flat();
            const foundGlobal = allEnvs.find((e) => e.pixiEnvName === globalTargetName);
            if (foundGlobal) {
                this.globalEnv = foundGlobal;
            } else if (allEnvs.length > 0) {
                this.globalEnv = undefined;
            }
        }

        if (changes.length > 0) {
            this._onDidChangeEnvironments.fire(changes);
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
                    oldEnv.hasIpykernel !== newEnv.hasIpykernel ||
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

    private resolveProjectPath(uri: Uri): string | undefined {
        return this.api.getPythonProject(uri)?.uri.fsPath || this.projectManager.findProjectForUri(uri);
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all' || !scope) {
            const all = Array.from(this.projectToEnvs.values()).flat();
            return sortPixiEnvironments(all);
        }

        if (scope instanceof Uri) {
            const projectPath = this.resolveProjectPath(scope);
            const envs = projectPath ? this.projectToEnvs.get(getProjectKey(projectPath)) || [] : [];
            return [...envs];
        }

        return [];
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        await this.initialize();

        if (!scope) {
            return this.globalEnv;
        }

        const projectPath = this.resolveProjectPath(scope);
        if (!projectPath) {
            return this.globalEnv;
        }

        const key = getProjectKey(projectPath);
        const projectEnvs = this.projectToEnvs.get(key) || [];
        const matched = matchEnvironmentForUri(scope, projectPath, projectEnvs);
        if (matched) {
            return matched;
        }

        const active = this.activeEnv.get(key);
        if (active) {
            return active;
        }

        return getDefaultEnvironment(projectEnvs) || this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        const pyEnv = environment as PixiPythonEnvironment | undefined;
        if (pyEnv) {
            const targetFolder = scope instanceof Uri ? scope : Array.isArray(scope) ? scope[0] : undefined;
            if (
                !(await ensureEnvironmentReady(pyEnv, {
                    action: 'activate environment',
                    targetName: pyEnv.displayName,
                    projectPath: targetFolder ?? pyEnv.projectPath,
                }))
            ) {
                return;
            }

            // Check if user is selecting an environment for a Jupyter Notebook
            const isNotebook =
                (scope instanceof Uri && scope.fsPath.endsWith('.ipynb')) ||
                (Array.isArray(scope) && scope.some((u) => u.fsPath.endsWith('.ipynb'))) ||
                (!scope && (window.activeNotebookEditor?.notebook.uri.fsPath.endsWith('.ipynb') ?? false));

            if (isNotebook && !pyEnv.hasIpykernel) {
                const projectPath = pyEnv.projectPath;
                const altEnvs = this.projectToEnvs.get(getProjectKey(projectPath)) || [];
                void promptToInstallIpykernel(pyEnv, this.projectManager, altEnvs, async (target) => {
                    await this.set(scope, target);
                });
            }
        }

        if (scope === undefined) {
            this.updateGlobalActiveEnv(pyEnv);
            await this.pixiApi.setActiveEnvironment(undefined, pyEnv?.pixiEnvName);
            return;
        }

        const uris = scope instanceof Uri ? [scope] : scope;

        for (const uri of uris) {
            const project = this.api.getPythonProject(uri);
            if (!project) {
                continue;
            }

            this.updateProjectActiveEnv(project.uri.fsPath, pyEnv);
            await this.pixiApi.setActiveEnvironment(project.uri, pyEnv?.pixiEnvName);
        }
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return this.get(context);
    }

    private updateProjectActiveEnv(projectPath: string, pyEnv: PixiPythonEnvironment | undefined): void {
        const key = getProjectKey(projectPath);
        const oldEnv = this.activeEnv.get(key);
        if (oldEnv?.envId.id === pyEnv?.envId.id) {
            return;
        }
        if (pyEnv) {
            this.activeEnv.set(key, pyEnv);
        } else {
            this.activeEnv.delete(key);
        }
        this._onDidChangeEnvironment.fire({ uri: Uri.file(projectPath), old: oldEnv, new: pyEnv });
    }

    private updateGlobalActiveEnv(pyEnv: PixiPythonEnvironment | undefined): void {
        const oldGlobal = this.globalEnv;
        if (oldGlobal?.envId.id === pyEnv?.envId.id) {
            return;
        }
        this.globalEnv = pyEnv;
        this._onDidChangeEnvironment.fire({ uri: undefined, old: oldGlobal, new: pyEnv });
    }
}
