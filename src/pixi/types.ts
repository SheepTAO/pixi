import { Package, PythonEnvironment } from '@vscode/python-environments';

export interface PixiEnvironmentPlatform {
    name: string;
    subdir?: string;
}

export interface PixiInfo {
    platform?: string;
    project_info?: {
        name: string;
        manifest_path: string;
    };
    environments_info: Array<{
        name: string;
        prefix: string;
        platforms?: Array<PixiEnvironmentPlatform | string>;
    }>;
}

export interface PixiPackage {
    name: string;
    version: string;
    is_explicit: boolean;
    kind?: 'conda' | 'pypi' | string;
    build?: string;
}

export interface PixiEnvironment extends PythonEnvironment {
    pixiInfo: PixiInfo;
    packages: Package[];
    pixiEnvName: string;
}
