import type {
    CppToolchainInfo,
    EnvironmentToolchains,
    PythonToolchainInfo,
    RToolchainInfo,
    RustToolchainInfo,
} from './toolchains';

export type { CppToolchainInfo, EnvironmentToolchains, PythonToolchainInfo, RToolchainInfo, RustToolchainInfo };

export interface PixiEnvironmentPlatform {
    name: string;
    subdir?: string;
    virtual_packages?: string[];
}

export interface PixiRawEnvironmentInfo {
    name: string;
    prefix: string;
    platforms?: Array<PixiEnvironmentPlatform | string>;
    resolved_platform?: PixiEnvironmentPlatform | string | null;
    channels?: string[];
    features?: string[];
    tasks?: string[];
    solve_group?: string | null;
    environment_size?: string | null;
    dependencies?: string[];
    pypi_dependencies?: string[];
}

export interface PixiInfo {
    platform?: string;
    cache_size?: string | null;
    project_info?: {
        name: string;
        manifest_path: string;
        version?: string | null;
        pixi_folder_size?: string | null;
    } | null;
    environments_info: PixiRawEnvironmentInfo[];
}

export interface PixiPackage {
    name: string;
    version: string;
    is_explicit: boolean;
    kind?: 'conda' | 'pypi' | string;
    build?: string;
    license?: string;
    source?: string;
    requested_spec?: string;
    is_local?: boolean;
    is_editable?: boolean;
    local_path?: string;
    local_manifest_path?: string;
}

export type PixiEnvironmentStatus = 'installed' | 'uninstalled' | 'incompatible';

export interface PixiEnvironmentInfo {
    pixiEnvName: string;
    prefix: string;
    projectPath: string;
    projectName: string;
    manifestPath: string;
    pixiStatus: PixiEnvironmentStatus;
    statusReason?: string;
    platforms?: Array<PixiEnvironmentPlatform | string>;
    resolvedPlatform?: string | null;
    channels?: string[];
    features?: string[];
    solveGroup?: string | null;
    environmentSize?: string | null;
    toolchains?: EnvironmentToolchains;
    dependencies?: string[];
    pypiDependencies?: string[];
}

export interface PixiProject {
    name: string;
    projectPath: string;
    manifestPath: string;
    version?: string | null;
    pixiFolderSize?: string | null;
    description?: string | null;
    requiresPixi?: string | null;
}
