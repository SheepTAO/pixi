export interface PixiEnvironmentPlatform {
    name: string;
    subdir?: string;
}

export interface PixiRawEnvironmentInfo {
    name: string;
    prefix: string;
    platforms?: Array<PixiEnvironmentPlatform | string>;
}

export interface PixiInfo {
    platform?: string;
    project_info?: {
        name: string;
        manifest_path: string;
    };
    environments_info: PixiRawEnvironmentInfo[];
}

export interface PixiPackage {
    name: string;
    version: string;
    is_explicit: boolean;
    kind?: 'conda' | 'pypi' | string;
    build?: string;
}

export type PixiEnvironmentStatus = 'installed' | 'uninstalled' | 'incompatible';

import {
    CppToolchainInfo,
    EnvironmentToolchains,
    PythonToolchainInfo,
    RToolchainInfo,
    RustToolchainInfo,
} from './toolchains';

export { CppToolchainInfo, EnvironmentToolchains, PythonToolchainInfo, RToolchainInfo, RustToolchainInfo };

export interface PixiEnvironmentInfo {
    pixiEnvName: string;
    prefix: string;
    projectPath: string;
    projectName: string;
    manifestPath: string;
    pixiStatus: PixiEnvironmentStatus;
    statusReason?: string;
    platforms?: Array<PixiEnvironmentPlatform | string>;
    toolchains?: EnvironmentToolchains;
}

export interface PixiProject {
    name: string;
    projectPath: string;
    manifestPath: string;
}
