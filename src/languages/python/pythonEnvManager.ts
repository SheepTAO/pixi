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
import * as fs from 'fs';
import { Disposable, EventEmitter, ThemeIcon, Uri, window, workspace } from 'vscode';

import { PixiExtensionApi } from '../../api';
import { getPixi } from '../../cli/pixiCli';
import { traceError, traceVerbose } from '../../common/logging';
import { getProjectEnvStorageKey, getWorkspacePersistentState, GLOBAL_ENV_KEY } from '../../common/persistentState';
import {
    ensureEnvironmentReady,
    getDefaultEnvironment,
    matchEnvironmentForUri,
    sortPixiEnvironments,
} from '../../core/environmentRules';
import { isPathInside, isSamePath, PathMap } from '../../core/projectDiscovery';
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
    private lastEffectiveGlobalEnv: PixiPythonEnvironment | undefined;
    private readonly activeEnv = new PathMap<PixiPythonEnvironment>();
    private readonly resourceEnv = new PathMap<PixiPythonEnvironment>();
    private projectToEnvs = new PathMap<PixiPythonEnvironment[]>();
    private readonly disposables: Disposable[] = [];

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    private initPromise?: Promise<void>;
    private activeRefreshPromise?: Promise<void>;
    private queuedRefreshPromise?: Promise<void>;

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
                const scope = e.scope;
                const scopePath = scope?.fsPath;
                if (e.environment) {
                    const project = scope ? this.api.getPythonProject(scope) : undefined;
                    const projectPath = project?.uri.fsPath || e.environment.projectPath;
                    const envs = this.projectToEnvs.get(projectPath) || [];
                    const pyEnv = envs.find((p) => p.pixiEnvName === e.environment?.pixiEnvName);
                    if (pyEnv) {
                        const isProject =
                            !scopePath ||
                            isSamePath(scopePath, projectPath) ||
                            this.projectManager.getProjectPaths().some((p) => isSamePath(p, scopePath));
                        if (isProject) {
                            this.updateProjectActiveEnv(projectPath, pyEnv, false, scope);
                            if (scope === undefined) {
                                this.updateGlobalActiveEnv(pyEnv);
                            } else if (!this.globalEnv) {
                                this.syncEffectiveGlobalEnv();
                            }
                        } else if (scope) {
                            this.updateResourceActiveEnv(scope, pyEnv);
                        }
                    }
                } else if (scope && scopePath) {
                    const project = this.api.getPythonProject(scope);
                    const projectPath = project?.uri.fsPath || scopePath;
                    const isProject =
                        isSamePath(scopePath, projectPath) ||
                        this.projectManager.getProjectPaths().some((p) => isSamePath(p, scopePath));
                    if (isProject) {
                        this.updateProjectActiveEnv(projectPath, undefined, false, scope);
                        if (!this.globalEnv) {
                            this.syncEffectiveGlobalEnv();
                        }
                    } else {
                        this.updateResourceActiveEnv(scope, undefined);
                    }
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
                    for (const nbEditor of window.visibleNotebookEditors ?? []) {
                        const env = await this.get(nbEditor.notebook.uri);
                        if (env) {
                            await this.set(nbEditor.notebook.uri, env);
                        }
                    }
                }
            }),
            workspace.onDidChangeNotebookDocument((e) => {
                if (e.metadata !== undefined) {
                    const projectPath = this.resolveProjectPath(e.notebook.uri);
                    if (!projectPath) {
                        return;
                    }
                    const envs = this.projectToEnvs.get(projectPath) || [];
                    const matched = this.findEnvFromNotebookMetadata(e.notebook.uri, envs);
                    if (matched) {
                        this.updateResourceActiveEnv(e.notebook.uri, matched);
                    }
                }
            }),
            workspace.onDidOpenNotebookDocument((nb) => {
                const projectPath = this.resolveProjectPath(nb.uri);
                if (!projectPath) {
                    return;
                }
                const envs = this.projectToEnvs.get(projectPath) || [];
                const matched = this.findEnvFromNotebookMetadata(nb.uri, envs);
                if (matched) {
                    this.updateResourceActiveEnv(nb.uri, matched);
                }
            }),
            window.onDidChangeActiveNotebookEditor((editor) => {
                if (editor) {
                    const projectPath = this.resolveProjectPath(editor.notebook.uri);
                    if (projectPath) {
                        const envs = this.projectToEnvs.get(projectPath) || [];
                        const matched =
                            this.resourceEnv.get(editor.notebook.uri.fsPath) ||
                            this.findEnvFromNotebookMetadata(editor.notebook.uri, envs);
                        if (matched) {
                            this.updateResourceActiveEnv(editor.notebook.uri, matched);
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
        this.lastEffectiveGlobalEnv = undefined;
        this.activeEnv.clear();
        this.resourceEnv.clear();
        this.projectToEnvs.clear();
    }

    public getPixiEnvironment(envId: string): PixiPythonEnvironment | undefined {
        for (const envs of this.projectToEnvs.values()) {
            const found = envs.find((e) => isSamePath(e.envId.id, envId));
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    public async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        await this.projectManager.refresh(scope instanceof Uri ? scope : undefined);
    }

    private refreshFromCore(): Promise<void> {
        if (this.activeRefreshPromise) {
            if (!this.queuedRefreshPromise) {
                this.queuedRefreshPromise = this.activeRefreshPromise.then(() => {
                    this.queuedRefreshPromise = undefined;
                    return this.refreshFromCore();
                });
            }
            return this.queuedRefreshPromise;
        }

        const run = async () => {
            try {
                await this.doRefreshFromCore();
            } catch (error) {
                traceError('Failed to refresh Python environments from Pixi core:', error);
            } finally {
                this.activeRefreshPromise = undefined;
            }
        };

        return (this.activeRefreshPromise = run());
    }

    private async doRefreshFromCore(): Promise<void> {
        const oldProjectToEnvs = new PathMap(this.projectToEnvs);
        const nextProjectToEnvs = new PathMap<PixiPythonEnvironment[]>();

        const projectPaths = this.projectManager.getProjectPaths();
        const projects = this.api.getPythonProjects();
        const projectMap = new PathMap(projects.map((p) => [p.uri.fsPath, p]));

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
            nextProjectToEnvs.set(projectPath, sorted);

            const oldEnvs = oldProjectToEnvs.get(projectPath) || [];
            changes.push(...this.diffEnvironments(oldEnvs, sorted));
        }

        // Handle deleted projects
        for (const [oldKey, oldEnvs] of oldProjectToEnvs) {
            if (!nextProjectToEnvs.has(oldKey)) {
                this.activeEnv.delete(oldKey);
                if (oldEnvs.length > 0) {
                    changes.push(...this.diffEnvironments(oldEnvs, []));
                }
            }
        }

        // Restore active environments from persistent state or re-link existing instances
        const storage = getWorkspacePersistentState();
        for (const [projectPath, envs] of nextProjectToEnvs) {
            const targetName =
                this.activeEnv.get(projectPath)?.pixiEnvName ||
                storage.get<string>(getProjectEnvStorageKey(projectPath));
            const found = targetName ? envs.find((e) => e.pixiEnvName === targetName) : undefined;
            if (found) {
                this.activeEnv.set(projectPath, found);
            } else {
                this.activeEnv.delete(projectPath);
            }
        }

        const globalTargetName = this.globalEnv?.pixiEnvName || storage.get<string>(GLOBAL_ENV_KEY);
        if (globalTargetName) {
            const allEnvs = Array.from(nextProjectToEnvs.values()).flat();
            const foundGlobal = allEnvs.find((e) => e.pixiEnvName === globalTargetName);
            if (foundGlobal) {
                this.globalEnv = foundGlobal;
            } else if (allEnvs.length > 0) {
                this.globalEnv = undefined;
            }
        }

        // Re-link per-resource active environments to updated environment instances
        for (const [resPath, oldEnv] of this.resourceEnv) {
            const projectPath = this.resolveProjectPath(Uri.file(resPath));
            if (projectPath) {
                const envs = nextProjectToEnvs.get(projectPath) || [];
                const found = envs.find((e) => e.pixiEnvName === oldEnv.pixiEnvName);
                if (found) {
                    this.resourceEnv.set(resPath, found);
                } else {
                    this.resourceEnv.delete(resPath);
                }
            } else {
                this.resourceEnv.delete(resPath);
            }
        }

        // Atomic swap: replace previous environment map in a single step
        this.projectToEnvs = nextProjectToEnvs;

        if (changes.length > 0) {
            this._onDidChangeEnvironments.fire(changes);
        }

        // Proactively notify VS Code python-envs of active environments for projects and open notebooks
        for (const projectPath of projectPaths) {
            const projectEnvs = nextProjectToEnvs.get(projectPath) || [];
            const active = this.activeEnv.get(projectPath) || getDefaultEnvironment(projectEnvs);
            if (active) {
                this._onDidChangeEnvironment.fire({ uri: Uri.file(projectPath), old: undefined, new: active });
            }
        }

        this.syncEffectiveGlobalEnv(true);

        for (const nb of workspace.notebookDocuments) {
            const projectPath = this.resolveProjectPath(nb.uri);
            if (!projectPath) {
                continue;
            }
            const projectEnvs = nextProjectToEnvs.get(projectPath) || [];
            const matched =
                this.resourceEnv.get(nb.uri.fsPath) || this.findEnvFromNotebookMetadata(nb.uri, projectEnvs);
            if (matched) {
                this.resourceEnv.set(nb.uri.fsPath, matched);
                this._onDidChangeEnvironment.fire({ uri: nb.uri, old: undefined, new: matched });
            }
        }
    }

    private diffEnvironments(
        oldEnvs: PixiPythonEnvironment[],
        newEnvs: PixiPythonEnvironment[],
    ): DidChangeEnvironmentsEventArgs {
        const oldMap = new PathMap(oldEnvs.map((e) => [e.envId.id, e]));
        const newMap = new PathMap(newEnvs.map((e) => [e.envId.id, e]));

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
            const envs = projectPath ? this.projectToEnvs.get(projectPath) || [] : [];
            return [...envs];
        }

        return [];
    }

    private findEnvFromNotebookMetadata(uri: Uri, envs: PixiPythonEnvironment[]): PixiPythonEnvironment | undefined {
        const isNotebook = uri.fsPath.endsWith('.ipynb') || uri.scheme === 'vscode-notebook-cell';
        if (!isNotebook) {
            return undefined;
        }

        const nbDoc = workspace.notebookDocuments.find((nb) => isSamePath(nb.uri.fsPath, uri.fsPath));
        const metadata = nbDoc?.metadata;
        let kernelspec = (metadata?.kernelspec || metadata?.custom?.metadata?.kernelspec) as
            | { display_name?: string; name?: string }
            | undefined;

        if (!kernelspec && uri.scheme === 'file' && fs.existsSync(uri.fsPath)) {
            try {
                let content: string | undefined;
                const stat = fs.statSync(uri.fsPath);
                // For files <= 2MB, read directly; for larger files, read first 64KB and last 64KB where metadata resides
                if (stat.size <= 2 * 1024 * 1024) {
                    content = fs.readFileSync(uri.fsPath, 'utf8');
                } else {
                    const fd = fs.openSync(uri.fsPath, 'r');
                    try {
                        const chunkSize = 64 * 1024;
                        const headBuf = Buffer.alloc(chunkSize);
                        const headBytes = fs.readSync(fd, headBuf, 0, chunkSize, 0);
                        const headStr = headBuf.subarray(0, headBytes).toString('utf8');

                        const tailOffset = Math.max(0, stat.size - chunkSize);
                        const tailBuf = Buffer.alloc(chunkSize);
                        const tailBytes = fs.readSync(fd, tailBuf, 0, chunkSize, tailOffset);
                        const tailStr = tailBuf.subarray(0, tailBytes).toString('utf8');

                        content = headStr + '\n' + tailStr;
                    } finally {
                        fs.closeSync(fd);
                    }
                }
                const match = content.match(/"kernelspec"\s*:\s*\{([^}]+)\}/);
                if (match) {
                    const dnMatch = match[1].match(/"display_name"\s*:\s*"([^"]+)"/);
                    const nameMatch = match[1].match(/"name"\s*:\s*"([^"]+)"/);
                    if (dnMatch || nameMatch) {
                        kernelspec = {
                            display_name: dnMatch ? dnMatch[1] : undefined,
                            name: nameMatch ? nameMatch[1] : undefined,
                        };
                    }
                }
            } catch {
                // ignore
            }
        }

        const displayName = kernelspec?.display_name;
        const kernelName = kernelspec?.name;
        if (!displayName && !kernelName) {
            return undefined;
        }

        // 1. Exact match against displayName or pixiEnvName
        if (displayName) {
            const exact = envs.find((e) => e.displayName === displayName || e.pixiEnvName === displayName);
            if (exact) {
                return exact;
            }
        }

        // 2. Sort envs by length descending to prioritize more specific names (e.g. 'dev-extra' before 'dev')
        const sortedEnvs = [...envs].sort((a, b) => b.pixiEnvName.length - a.pixiEnvName.length);

        if (displayName) {
            for (const env of sortedEnvs) {
                const escapedEnv = env.pixiEnvName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const escapedProj = env.projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`(?:^|[:(\\[/\\s]|${escapedProj}:)${escapedEnv}(?:$|[ )\\]/\\s])`, 'i');
                if (pattern.test(displayName)) {
                    return env;
                }
            }
        }

        if (kernelName && kernelName !== 'python3') {
            for (const env of sortedEnvs) {
                const escapedEnv = env.pixiEnvName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const escapedProj = env.projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`(?:^|[-_\\s]|${escapedProj}[-_])${escapedEnv}(?:$|[-_\\s])`, 'i');
                if (pattern.test(kernelName)) {
                    return env;
                }
            }
        }

        return undefined;
    }

    private getEffectiveGlobalEnv(): PixiPythonEnvironment | undefined {
        if (this.globalEnv) {
            return this.globalEnv;
        }

        // 1. Active editor or notebook document's resource or project environment
        const activeUri = window.activeTextEditor?.document.uri || window.activeNotebookEditor?.notebook.uri;
        if (activeUri) {
            const resEnv = this.resourceEnv.get(activeUri.fsPath);
            if (resEnv) {
                return resEnv;
            }
            const projectPath = this.resolveProjectPath(activeUri);
            if (projectPath) {
                const active = this.activeEnv.get(projectPath);
                if (active) {
                    return active;
                }
                const envs = this.projectToEnvs.get(projectPath) || [];
                const def = getDefaultEnvironment(envs);
                if (def) {
                    return def;
                }
            }
        }

        const projectPaths = this.projectManager.getProjectPaths();
        const primaryFolder = workspace.workspaceFolders?.[0]?.uri.fsPath;
        const sortedProjectPaths = [...projectPaths];
        if (primaryFolder) {
            sortedProjectPaths.sort((a, b) => {
                const aIsPrimary = isPathInside(a, primaryFolder);
                const bIsPrimary = isPathInside(b, primaryFolder);
                if (aIsPrimary && !bIsPrimary) {
                    return -1;
                }
                if (!aIsPrimary && bIsPrimary) {
                    return 1;
                }
                return 0;
            });
        }

        // 2. Workspace projects' active environment
        for (const p of sortedProjectPaths) {
            const active = this.activeEnv.get(p);
            if (active) {
                return active;
            }
        }

        // 3. Workspace projects' default environment
        for (const p of sortedProjectPaths) {
            const envs = this.projectToEnvs.get(p) || [];
            const def = getDefaultEnvironment(envs);
            if (def) {
                return def;
            }
        }

        // 4. Default environment across all discovered environments
        const allEnvs = Array.from(this.projectToEnvs.values()).flat();
        return getDefaultEnvironment(allEnvs);
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        await this.initialize();

        if (!scope) {
            return this.getEffectiveGlobalEnv();
        }

        const projectPath = this.resolveProjectPath(scope);
        if (!projectPath) {
            return this.getEffectiveGlobalEnv();
        }

        const projectEnvs = this.projectToEnvs.get(projectPath) || [];

        // 1. Explicit per-resource (notebook or document) environment selection
        if (scope instanceof Uri) {
            const resourceMatch = this.resourceEnv.get(scope.fsPath);
            if (resourceMatch) {
                return resourceMatch;
            }

            // 2. Check open notebook document metadata (kernelspec)
            const nbMatch = this.findEnvFromNotebookMetadata(scope, projectEnvs);
            if (nbMatch) {
                this.resourceEnv.set(scope.fsPath, nbMatch);
                return nbMatch;
            }
        }

        // 3. Matching by configured environment rules
        const matched = matchEnvironmentForUri(scope, projectPath, projectEnvs);
        if (matched) {
            return matched;
        }

        // 4. Project-level active environment
        const active = this.activeEnv.get(projectPath);
        if (active) {
            return active;
        }

        // 5. Default project environment, or global fallback
        return getDefaultEnvironment(projectEnvs) || this.getEffectiveGlobalEnv();
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
                (scope instanceof Uri &&
                    (scope.fsPath.endsWith('.ipynb') || scope.scheme === 'vscode-notebook-cell')) ||
                (Array.isArray(scope) &&
                    scope.some((u) => u.fsPath.endsWith('.ipynb') || u.scheme === 'vscode-notebook-cell')) ||
                (!scope && (window.activeNotebookEditor?.notebook.uri.fsPath.endsWith('.ipynb') ?? false));

            if (isNotebook && !pyEnv.hasIpykernel) {
                const projectPath = pyEnv.projectPath;
                const altEnvs = this.projectToEnvs.get(projectPath) || [];
                void promptToInstallIpykernel(pyEnv, this.projectManager, altEnvs, async (target) => {
                    await this.set(scope, target);
                });
            }
        }

        if (scope === undefined) {
            this.updateGlobalActiveEnv(pyEnv, true);
            await this.pixiApi.setActiveEnvironment(undefined, pyEnv?.pixiEnvName);
            return;
        }

        const uris = scope instanceof Uri ? [scope] : scope;

        for (const uri of uris) {
            let projectPath = this.resolveProjectPath(uri);
            if (!projectPath && pyEnv) {
                projectPath = pyEnv.projectPath;
            }
            if (!projectPath) {
                continue;
            }

            const isProjectFolder =
                isSamePath(uri.fsPath, projectPath) ||
                this.projectManager.getProjectPaths().some((p) => isSamePath(p, uri.fsPath));

            if (isProjectFolder) {
                this.updateProjectActiveEnv(projectPath, pyEnv, true, uri);
                await this.pixiApi.setActiveEnvironment(Uri.file(projectPath), pyEnv?.pixiEnvName);
            } else {
                this.updateResourceActiveEnv(uri, pyEnv, true);
            }
        }
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        await this.initialize();

        // 1. If context is a PythonEnvironment object with an envId or id
        const rawEnvId = (context as any)?.envId;
        const envId = typeof rawEnvId === 'string' ? rawEnvId : (rawEnvId?.id ?? (context as any)?.id);
        if (typeof envId === 'string') {
            const byId = this.getPixiEnvironment(envId);
            if (byId) {
                return byId;
            }
        }

        // 2. If context is a Uri, string, or has an fsPath, match by sysPrefix, environmentPath, or python executable
        const targetPath =
            typeof context === 'string'
                ? context
                : context instanceof Uri
                  ? context.fsPath
                  : (context as any)?.fsPath ||
                    (context as any)?.environmentPath?.fsPath ||
                    (context as any)?.execInfo?.run?.executable ||
                    (context as any)?.path;
        if (typeof targetPath === 'string') {
            for (const envs of this.projectToEnvs.values()) {
                for (const env of envs) {
                    if (
                        isSamePath(env.sysPrefix, targetPath) ||
                        isSamePath(env.environmentPath?.fsPath, targetPath) ||
                        isSamePath(env.execInfo?.run?.executable, targetPath)
                    ) {
                        return env;
                    }
                }
            }
        }

        return undefined;
    }

    private updateProjectActiveEnv(
        projectPath: string,
        pyEnv: PixiPythonEnvironment | undefined,
        forceFire = false,
        sourceUri?: Uri,
    ): void {
        const oldEnv = this.activeEnv.get(projectPath);
        const isSame = oldEnv?.envId.id === pyEnv?.envId.id;
        if (isSame && !forceFire) {
            return;
        }
        if (pyEnv) {
            this.activeEnv.set(projectPath, pyEnv);
        } else {
            this.activeEnv.delete(projectPath);
        }
        this._onDidChangeEnvironment.fire({ uri: sourceUri ?? Uri.file(projectPath), old: oldEnv, new: pyEnv });
    }

    private updateResourceActiveEnv(uri: Uri, pyEnv: PixiPythonEnvironment | undefined, forceFire = false): void {
        const key = uri.fsPath;
        const oldEnv = this.resourceEnv.get(key);
        const isSame = oldEnv?.envId.id === pyEnv?.envId.id;
        if (isSame && !forceFire) {
            return;
        }
        if (pyEnv) {
            this.resourceEnv.set(key, pyEnv);
        } else {
            this.resourceEnv.delete(key);
        }
        this._onDidChangeEnvironment.fire({ uri, old: oldEnv, new: pyEnv });
        if (uri.scheme === 'vscode-notebook-cell') {
            this._onDidChangeEnvironment.fire({ uri: Uri.file(uri.fsPath), old: oldEnv, new: pyEnv });
        }
    }

    private syncEffectiveGlobalEnv(forceFire = false): void {
        const effectiveGlobal = this.getEffectiveGlobalEnv();
        const isSame = this.lastEffectiveGlobalEnv?.envId.id === effectiveGlobal?.envId.id;
        if (isSame && !forceFire) {
            return;
        }
        const oldEnv = this.lastEffectiveGlobalEnv;
        if (!oldEnv && !effectiveGlobal) {
            return;
        }
        this.lastEffectiveGlobalEnv = effectiveGlobal;
        this._onDidChangeEnvironment.fire({
            uri: undefined,
            old: oldEnv,
            new: effectiveGlobal,
        });
    }

    private updateGlobalActiveEnv(pyEnv: PixiPythonEnvironment | undefined, forceFire = false): void {
        const oldGlobal = this.globalEnv;
        const isSame = oldGlobal?.envId.id === pyEnv?.envId.id;
        if (isSame && !forceFire) {
            return;
        }
        this.globalEnv = pyEnv;
        this.syncEffectiveGlobalEnv(forceFire);
    }
}
