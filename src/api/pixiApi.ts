import * as path from 'path';
import { Disposable, Event, EventEmitter, Uri, workspace } from 'vscode';

import { getWorkspacePersistentState } from '../common/persistentState';
import { matchEnvironmentRule } from '../core/environmentRules';
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
            this.projectManager.onDidProjectsChanged(async () => {
                await this.loadSavedActiveEnvironments();
            }),
            this.projectManager.onDidChangeEnvironments(async () => {
                for (const [projectPath, envName] of this.activeEnvNames) {
                    const envs = this.projectManager.getEnvironmentsForProject(projectPath);
                    if (!envs.some((e) => e.pixiEnvName === envName)) {
                        this.activeEnvNames.delete(projectPath);
                    }
                }
                await this.loadSavedActiveEnvironments();
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

        // 2. Check active environment for this project
        const activeName = this.activeEnvNames.get(projectPath);
        if (activeName) {
            const match = envs.find((e) => e.pixiEnvName === activeName);
            if (match) {
                return match;
            }
        }

        // 3. Fallback to default/installed environment in this project
        return (
            envs.find((e) => e.pixiEnvName === 'default' && e.pixiStatus === 'installed') ||
            envs.find((e) => e.pixiStatus === 'installed') ||
            envs.find((e) => e.pixiEnvName === 'default') ||
            envs[0]
        );
    }

    public async refresh(scope?: Uri): Promise<void> {
        return this.projectManager.refresh(scope);
    }

    public async getActiveEnvironment(scope?: Uri): Promise<PixiEnvironmentInfo | undefined> {
        const storage = await getWorkspacePersistentState();

        if (scope) {
            const projectPath = this.projectManager.findProjectForUri(scope);
            if (projectPath) {
                if (!this.activeEnvNames.has(projectPath)) {
                    const saved = await storage.get<string>(`projectEnvName:${projectPath}`);
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
            globalName = await storage.get<string>('globalEnvName');
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
                const saved = await storage.get<string>(`projectEnvName:${projectPath}`);
                if (saved) {
                    this.activeEnvNames.set(projectPath, saved);
                }
            }
            const envs = this.projectManager.getEnvironmentsForProject(projectPath);
            const activeName = this.activeEnvNames.get(projectPath);
            if (activeName) {
                const match = envs.find((e) => e.pixiEnvName === activeName);
                if (match) {
                    return match;
                }
            }
            return (
                envs.find((e) => e.pixiEnvName === 'default' && e.pixiStatus === 'installed') ||
                envs.find((e) => e.pixiStatus === 'installed') ||
                envs.find((e) => e.pixiEnvName === 'default') ||
                envs[0]
            );
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

            const current = this.activeEnvNames.get(projectPath);
            if (current === envName) {
                return true;
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

        if (this.globalActiveEnvName === envName) {
            return true;
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
