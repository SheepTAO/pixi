import { Disposable, Event, EventEmitter, Uri } from 'vscode';

import { getWorkspacePersistentState } from '../common/persistentState';
import { getDefaultEnvironment, matchEnvironmentForUri } from '../core/environmentRules';
import { PixiProjectManager } from '../core/projectManager';
import { ActiveEnvironmentChangeEvent, PixiEnvironmentInfo, PixiExtensionApi, PixiPackage, PixiProject } from './types';

export class PixiExtensionApiImpl implements PixiExtensionApi, Disposable {
    private readonly activeEnvNames = new Map<string, string>(); // projectPath -> envName
    private globalActiveEnvName?: string;
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
            this.projectManager.onDidProjectsChanged(() => {
                this.loadSavedActiveEnvironments();
            }),
            this.projectManager.onDidChangeEnvironments(async () => {
                const storage = getWorkspacePersistentState();
                for (const [projectPath, envName] of this.activeEnvNames) {
                    const envs = this.projectManager.getEnvironmentsForProject(projectPath);
                    if (envs.length > 0 && !envs.some((e) => e.pixiEnvName === envName)) {
                        this.activeEnvNames.delete(projectPath);
                        await storage.set(`projectEnvName:${projectPath}`, undefined);
                    }
                }
                this.loadSavedActiveEnvironments();
            }),
        );

        this.loadSavedActiveEnvironments();
    }

    private loadSavedActiveEnvironments(): void {
        try {
            const storage = getWorkspacePersistentState();
            for (const projectPath of this.projectManager.getProjectPaths()) {
                const savedEnv = storage.get<string>(`projectEnvName:${projectPath}`);
                if (savedEnv) {
                    const envs = this.projectManager.getEnvironmentsForProject(projectPath);
                    if (envs.length === 0 || envs.some((e) => e.pixiEnvName === savedEnv)) {
                        this.activeEnvNames.set(projectPath, savedEnv);
                    } else {
                        void storage.set(`projectEnvName:${projectPath}`, undefined);
                        this.activeEnvNames.delete(projectPath);
                    }
                }
            }
            const globalSaved = storage.get<string>('globalEnvName');
            if (globalSaved) {
                const allEnvs = this.projectManager.getAllEnvironments();
                if (allEnvs.length === 0 || allEnvs.some((e) => e.pixiEnvName === globalSaved)) {
                    this.globalActiveEnvName = globalSaved;
                } else {
                    void storage.set('globalEnvName', undefined);
                    this.globalActiveEnvName = undefined;
                }
            }
        } catch {
            // ignore
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
        const projectPath = this.projectManager.findProjectForUri(uri);
        if (!projectPath) {
            return undefined;
        }

        const envs = this.projectManager.getEnvironmentsForProject(projectPath);
        if (envs.length === 0) {
            return undefined;
        }
        if (envs.length === 1) {
            return envs[0];
        }

        // 1. Check file-level environment rules
        const matched = matchEnvironmentForUri(uri, projectPath, envs);
        if (matched) {
            return matched;
        }

        // 2. Fallback to active or default environment for this project
        return this.resolveProjectActiveOrDefault(projectPath, envs);
    }

    private resolveProjectActiveOrDefault(
        projectPath: string,
        envs: PixiEnvironmentInfo[],
    ): PixiEnvironmentInfo | undefined {
        const activeName = this.activeEnvNames.get(projectPath);
        if (activeName) {
            const match = envs.find((e) => e.pixiEnvName === activeName);
            if (match) {
                return match;
            }
        }
        return getDefaultEnvironment(envs);
    }

    public async refresh(scope?: Uri): Promise<void> {
        return this.projectManager.refresh(scope);
    }

    public async getActiveEnvironment(scope?: Uri): Promise<PixiEnvironmentInfo | undefined> {
        const storage = getWorkspacePersistentState();

        if (scope) {
            const projectPath = this.projectManager.findProjectForUri(scope);
            if (projectPath) {
                if (!this.activeEnvNames.has(projectPath)) {
                    const saved = storage.get<string>(`projectEnvName:${projectPath}`);
                    if (saved) {
                        this.activeEnvNames.set(projectPath, saved);
                    }
                }
                return this.getEnvironmentForUri(scope);
            }
        }

        // Global or first project default
        let globalName = this.globalActiveEnvName;
        if (!globalName) {
            globalName = storage.get<string>('globalEnvName');
            if (globalName) {
                this.globalActiveEnvName = globalName;
            }
        }
        if (globalName) {
            const allEnvs = this.projectManager.getAllEnvironments();
            const match = allEnvs.find((e) => e.pixiEnvName === globalName);
            if (match) {
                return match;
            }
        }

        const projects = this.projectManager.getProjects();
        if (projects.length > 0) {
            const projectPath = projects[0].projectPath;
            if (!this.activeEnvNames.has(projectPath)) {
                const saved = storage.get<string>(`projectEnvName:${projectPath}`);
                if (saved) {
                    this.activeEnvNames.set(projectPath, saved);
                }
            }
            const envs = this.projectManager.getEnvironmentsForProject(projectPath);
            return this.resolveProjectActiveOrDefault(projectPath, envs);
        }

        return undefined;
    }

    public async setActiveEnvironment(scope: Uri | undefined, envName?: string): Promise<boolean> {
        let projectPath: string | undefined;
        if (scope) {
            projectPath = this.projectManager.findProjectForUri(scope);
        }

        if (!projectPath) {
            const projects = this.projectManager.getProjects();
            if (projects.length > 0) {
                projectPath = projects[0].projectPath;
            }
        }

        if (projectPath) {
            if (!envName) {
                if (!this.activeEnvNames.has(projectPath)) {
                    return true;
                }
                this.activeEnvNames.delete(projectPath);
                try {
                    const storage = getWorkspacePersistentState();
                    await storage.set(`projectEnvName:${projectPath}`, undefined);
                } catch {
                    // ignore
                }
                this._onDidChangeActiveEnvironment.fire({ scope, environment: undefined });
                return true;
            }

            const envs = this.projectManager.getEnvironmentsForProject(projectPath);
            const targetEnv = envs.find((e) => e.pixiEnvName === envName);
            if (!targetEnv) {
                return false;
            }

            const current = this.activeEnvNames.get(projectPath);
            if (current === envName) {
                return true;
            }

            this.activeEnvNames.set(projectPath, envName);
            try {
                const storage = getWorkspacePersistentState();
                await storage.set(`projectEnvName:${projectPath}`, envName);
            } catch {
                // ignore
            }

            this._onDidChangeActiveEnvironment.fire({ scope, environment: targetEnv });
            return true;
        }

        // Global fallback
        if (!envName) {
            if (!this.globalActiveEnvName) {
                return true;
            }
            this.globalActiveEnvName = undefined;
            try {
                const storage = getWorkspacePersistentState();
                await storage.set('globalEnvName', undefined);
            } catch {
                // ignore
            }
            this._onDidChangeActiveEnvironment.fire({ scope, environment: undefined });
            return true;
        }

        const allEnvs = this.projectManager.getAllEnvironments();
        const targetEnv = allEnvs.find((e) => e.pixiEnvName === envName);
        if (!targetEnv) {
            return false;
        }

        if (this.globalActiveEnvName === envName) {
            return true;
        }

        this.globalActiveEnvName = envName;
        try {
            const storage = getWorkspacePersistentState();
            await storage.set('globalEnvName', envName);
        } catch {
            // ignore
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
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

export function createPixiApi(projectManager: PixiProjectManager, version: string): PixiExtensionApi & Disposable {
    return new PixiExtensionApiImpl(projectManager, version);
}
