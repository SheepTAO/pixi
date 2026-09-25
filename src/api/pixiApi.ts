import { Disposable, Event, EventEmitter, Uri } from 'vscode';

import { getWorkspacePersistentState } from '../common/persistentState';
import { PixiProjectManager } from '../core/projectManager';
import { ActiveEnvironmentChangeEvent, PixiEnvironmentInfo, PixiExtensionApi, PixiPackage, PixiProject } from './types';

export class PixiExtensionApiImpl implements PixiExtensionApi, Disposable {
    readonly version: string;
    private readonly activeEnvNames = new Map<string, string>(); // projectPath -> envName
    private globalActiveEnvName?: string;
    private readonly disposables: Disposable[] = [];

    private readonly _onDidChangeActiveEnvironment = new EventEmitter<ActiveEnvironmentChangeEvent>();
    readonly onDidChangeActiveEnvironment: Event<ActiveEnvironmentChangeEvent> =
        this._onDidChangeActiveEnvironment.event;

    constructor(
        private readonly projectManager: PixiProjectManager,
        version = '1.0.1',
    ) {
        this.version = version;

        this.disposables.push(
            this._onDidChangeActiveEnvironment,
            this.projectManager.onDidChangeEnvironments(() => {
                for (const [projectPath, envName] of this.activeEnvNames) {
                    const envs = this.projectManager.getEnvironmentsForProject(projectPath);
                    if (!envs.some((e) => e.pixiEnvName === envName)) {
                        this.activeEnvNames.delete(projectPath);
                    }
                }
            }),
        );

        void this.loadSavedActiveEnvironments();
    }

    private async loadSavedActiveEnvironments(): Promise<void> {
        try {
            const storage = await getWorkspacePersistentState();
            for (const projectPath of this.projectManager.getProjectPaths()) {
                const savedEnv = await storage.get<string>(`projectEnvName:${projectPath}`);
                if (savedEnv) {
                    this.activeEnvNames.set(projectPath, savedEnv);
                }
            }
            const globalSaved = await storage.get<string>('globalEnvName');
            if (globalSaved) {
                this.globalActiveEnvName = globalSaved;
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
        return this.projectManager.getEnvironmentForUri(uri);
    }

    public async refresh(scope?: Uri): Promise<void> {
        return this.projectManager.refresh(scope);
    }

    public async getActiveEnvironment(scope?: Uri): Promise<PixiEnvironmentInfo | undefined> {
        if (scope) {
            const uriEnv = this.projectManager.getEnvironmentForUri(scope);
            if (uriEnv) {
                return uriEnv;
            }

            const projectPath = this.projectManager.findProjectForUri(scope);
            if (projectPath) {
                const activeName = this.activeEnvNames.get(projectPath);
                const envs = this.projectManager.getEnvironmentsForProject(projectPath);
                if (activeName) {
                    const match = envs.find((e) => e.pixiEnvName === activeName);
                    if (match) {
                        return match;
                    }
                }
                const defaultEnv = envs.find((e) => e.pixiEnvName === 'default') || envs[0];
                if (defaultEnv) {
                    return defaultEnv;
                }
            }
        }

        // Global or first project default
        if (this.globalActiveEnvName) {
            const allEnvs = this.projectManager.getAllEnvironments();
            const match = allEnvs.find((e) => e.pixiEnvName === this.globalActiveEnvName);
            if (match) {
                return match;
            }
        }

        const projects = this.projectManager.getProjects();
        if (projects.length > 0) {
            const envs = this.projectManager.getEnvironmentsForProject(projects[0].projectPath);
            return envs.find((e) => e.pixiEnvName === 'default') || envs[0];
        }

        return undefined;
    }

    public async setActiveEnvironment(scope: Uri | undefined, envName: string): Promise<boolean> {
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
            const envs = this.projectManager.getEnvironmentsForProject(projectPath);
            const targetEnv = envs.find((e) => e.pixiEnvName === envName);
            if (!targetEnv) {
                return false;
            }

            this.activeEnvNames.set(projectPath, envName);
            try {
                const storage = await getWorkspacePersistentState();
                await storage.set(`projectEnvName:${projectPath}`, envName);
            } catch {
                // ignore
            }

            this._onDidChangeActiveEnvironment.fire({ scope, environment: targetEnv });
            return true;
        }

        // Global fallback
        const allEnvs = this.projectManager.getAllEnvironments();
        const targetEnv = allEnvs.find((e) => e.pixiEnvName === envName);
        if (!targetEnv) {
            return false;
        }

        this.globalActiveEnvName = envName;
        try {
            const storage = await getWorkspacePersistentState();
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

export function createPixiApi(projectManager: PixiProjectManager, version = '1.0.1'): PixiExtensionApi & Disposable {
    return new PixiExtensionApiImpl(projectManager, version);
}
