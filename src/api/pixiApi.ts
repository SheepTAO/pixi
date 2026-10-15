import { Disposable, Event, EventEmitter, Uri } from 'vscode';

import { getProjectEnvStorageKey, getWorkspacePersistentState, GLOBAL_ENV_KEY } from '../common/persistentState';
import { PixiProjectManager } from '../core/projectManager';
import { ActiveEnvironmentChangeEvent, PixiEnvironmentInfo, PixiExtensionApi, PixiPackage, PixiProject } from './types';

export class PixiExtensionApiImpl implements PixiExtensionApi, Disposable {
    private readonly disposables: Disposable[] = [];

    private readonly _onDidChangeActiveEnvironment = new EventEmitter<ActiveEnvironmentChangeEvent>();
    readonly onDidChangeActiveEnvironment: Event<ActiveEnvironmentChangeEvent> =
        this._onDidChangeActiveEnvironment.event;

    constructor(
        private readonly projectManager: PixiProjectManager,
        public readonly version: string,
    ) {
        this.disposables.push(
            this._onDidChangeActiveEnvironment,
            this.projectManager.onDidChangeEnvironments(() => {
                this.pruneSavedActiveEnvironments();
            }),
        );
    }

    private pruneSavedActiveEnvironments(): void {
        const storage = getWorkspacePersistentState();
        for (const projectPath of this.projectManager.getProjectPaths()) {
            const key = getProjectEnvStorageKey(projectPath);
            const savedEnv = storage.get<string>(key);
            if (savedEnv) {
                const envs = this.projectManager.getEnvironmentsForProject(projectPath);
                if (envs.length > 0 && !envs.some((e) => e.pixiEnvName === savedEnv)) {
                    void storage.set(key, undefined);
                }
            }
        }
        const globalSaved = storage.get<string>(GLOBAL_ENV_KEY);
        if (globalSaved) {
            const allEnvs = this.projectManager.getAllEnvironments();
            if (allEnvs.length > 0 && !allEnvs.some((e) => e.pixiEnvName === globalSaved)) {
                void storage.set(GLOBAL_ENV_KEY, undefined);
            }
        }
    }

    public getProjectPaths(): string[] {
        return this.projectManager.getProjectPaths();
    }

    public getProjects(): PixiProject[] {
        return this.projectManager.getProjects();
    }

    public getEnvironments(projectPath: string): PixiEnvironmentInfo[] {
        return this.projectManager.getEnvironmentsForProject(projectPath);
    }

    public getAllEnvironments(): PixiEnvironmentInfo[] {
        return this.projectManager.getAllEnvironments();
    }

    public async getPackages(envName: string, projectPath: string): Promise<PixiPackage[]> {
        return this.projectManager.getPackagesForEnvironment(envName, projectPath);
    }

    public findProjectForUri(uri: Uri): string | undefined {
        return this.projectManager.findProjectForUri(uri);
    }

    public getEnvironmentForUri(uri: Uri): PixiEnvironmentInfo | undefined {
        return this.projectManager.getEnvironmentForUri(uri);
    }

    public async refresh(scope?: Uri): Promise<void> {
        return this.projectManager.refresh(scope);
    }

    public async getActiveEnvironment(scope?: Uri): Promise<PixiEnvironmentInfo | undefined> {
        if (scope) {
            const env = this.getEnvironmentForUri(scope);
            if (env) {
                return env;
            }
        }

        // Global or first project default
        const globalActiveEnvName = getWorkspacePersistentState().get<string>(GLOBAL_ENV_KEY);
        if (globalActiveEnvName) {
            const allEnvs = this.projectManager.getAllEnvironments();
            const match = allEnvs.find((e) => e.pixiEnvName === globalActiveEnvName);
            if (match) {
                return match;
            }
        }

        const projects = this.projectManager.getProjects();
        if (projects.length > 0) {
            return this.projectManager.resolveProjectActiveOrDefault(projects[0].projectPath);
        }

        return undefined;
    }

    public async setActiveEnvironment(scope: Uri | undefined, envName?: string): Promise<boolean> {
        const scopedProjectPath = scope ? this.projectManager.findProjectForUri(scope) : undefined;
        let projectPath = scopedProjectPath ?? this.projectManager.getProjects()[0]?.projectPath;

        let targetEnv: PixiEnvironmentInfo | undefined;
        if (envName) {
            targetEnv = projectPath
                ? this.projectManager.getEnvironmentsForProject(projectPath).find((e) => e.pixiEnvName === envName)
                : undefined;
            if (!targetEnv && !scopedProjectPath) {
                targetEnv = this.projectManager.getAllEnvironments().find((e) => e.pixiEnvName === envName);
                if (targetEnv) {
                    projectPath = targetEnv.projectPath;
                }
            }
            if (!targetEnv) {
                return false;
            }
        }

        const storage = getWorkspacePersistentState();
        const targetName = targetEnv?.pixiEnvName;
        const storageKey = projectPath ? getProjectEnvStorageKey(projectPath) : GLOBAL_ENV_KEY;
        const prevScoped = storage.get<string>(storageKey);
        const prevGlobal = !scope ? storage.get<string>(GLOBAL_ENV_KEY) : targetName;

        if (prevScoped === targetName && prevGlobal === targetName) {
            return true;
        }

        if (prevScoped !== targetName) {
            await storage.set(storageKey, targetName);
        }
        if (!scope && prevGlobal !== targetName && storageKey !== GLOBAL_ENV_KEY) {
            await storage.set(GLOBAL_ENV_KEY, targetName);
        }
        this._onDidChangeActiveEnvironment.fire({ scope, environment: targetEnv });
        return true;
    }

    public get onDidProjectsChanged(): Event<string[]> {
        return this.projectManager.onDidProjectsChanged;
    }

    public get onDidChangeEnvironments(): Event<void> {
        return this.projectManager.onDidChangeEnvironments;
    }

    public dispose(): void {
        Disposable.from(...this.disposables).dispose();
    }
}

export function createPixiApi(projectManager: PixiProjectManager, version: string): PixiExtensionApi & Disposable {
    return new PixiExtensionApiImpl(projectManager, version);
}
