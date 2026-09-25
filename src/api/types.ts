import { Event, Uri } from 'vscode';

import {
    CppToolchainInfo,
    EnvironmentToolchains,
    PixiEnvironmentInfo,
    PixiEnvironmentPlatform,
    PixiEnvironmentStatus,
    PixiPackage,
    PixiProject,
    PythonToolchainInfo,
    RToolchainInfo,
    RustToolchainInfo,
} from '../core/types';

export {
    CppToolchainInfo,
    EnvironmentToolchains,
    PixiEnvironmentInfo,
    PixiEnvironmentPlatform,
    PixiEnvironmentStatus,
    PixiPackage,
    PixiProject,
    PythonToolchainInfo,
    RToolchainInfo,
    RustToolchainInfo,
};

export interface ActiveEnvironmentChangeEvent {
    scope?: Uri;
    environment?: PixiEnvironmentInfo;
}

export interface PixiExtensionApi {
    readonly version: string;
    getProjectPaths(): string[];
    getProjects(): PixiProject[];
    getEnvironments(projectPath: string): PixiEnvironmentInfo[];
    getAllEnvironments(): PixiEnvironmentInfo[];
    getPackages(envName: string, projectPath: string): Promise<PixiPackage[]>;
    findProjectForUri(uri: Uri): string | undefined;
    getEnvironmentForUri(uri: Uri): PixiEnvironmentInfo | undefined;
    getActiveEnvironment(scope?: Uri): Promise<PixiEnvironmentInfo | undefined>;
    setActiveEnvironment(scope: Uri | undefined, envName: string): Promise<boolean>;
    refresh(scope?: Uri): Promise<void>;
    readonly onDidProjectsChanged: Event<string[]>;
    readonly onDidChangeEnvironments: Event<void>;
    readonly onDidChangeActiveEnvironment: Event<ActiveEnvironmentChangeEvent>;
}
