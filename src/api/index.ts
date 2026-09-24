import { Event, Uri } from 'vscode';

import { matchEnvironmentName, matchEnvironmentRule } from '../core/environmentRules';
import { PixiProjectManager } from '../core/projectManager';
import {
    CppToolchainInfo,
    EnvironmentToolchains,
    PixiEnvironmentInfo,
    PixiPackage,
    PixiProject,
    PythonToolchainInfo,
    RToolchainInfo,
    RustToolchainInfo,
} from '../core/types';

export {
    CppToolchainInfo,
    EnvironmentToolchains,
    matchEnvironmentName,
    matchEnvironmentRule,
    PixiEnvironmentInfo,
    PixiPackage,
    PixiProject,
    PythonToolchainInfo,
    RToolchainInfo,
    RustToolchainInfo,
};

export interface PixiExtensionApi {
    readonly version: string;
    getProjectPaths(): string[];
    getProjects(): PixiProject[];
    getEnvironments(projectPath: string): PixiEnvironmentInfo[];
    getAllEnvironments(): PixiEnvironmentInfo[];
    getPackages(envName: string, projectPath: string): Promise<PixiPackage[]>;
    findProjectForUri(uri: Uri): string | undefined;
    getEnvironmentForUri(uri: Uri): PixiEnvironmentInfo | undefined;
    refresh(scope?: Uri): Promise<void>;
    readonly onDidProjectsChanged: Event<string[]>;
    readonly onDidChangeEnvironments: Event<void>;
}

export function createPixiApi(projectManager: PixiProjectManager): PixiExtensionApi {
    return {
        version: '1.0.0',
        getProjectPaths: () => projectManager.getProjectPaths(),
        getProjects: () => projectManager.getProjects(),
        getEnvironments: (projectPath: string) => projectManager.getEnvironmentsForProject(projectPath),
        getAllEnvironments: () => projectManager.getAllEnvironments(),
        getPackages: (envName: string, projectPath: string) =>
            projectManager.getPackagesForEnvironment(envName, projectPath),
        findProjectForUri: (uri: Uri) => projectManager.findProjectForUri(uri),
        getEnvironmentForUri: (uri: Uri) => projectManager.getEnvironmentForUri(uri),
        refresh: (scope?: Uri) => projectManager.refresh(scope),
        onDidProjectsChanged: projectManager.onDidProjectsChanged,
        onDidChangeEnvironments: projectManager.onDidChangeEnvironments,
    };
}
