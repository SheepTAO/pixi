import { PythonEnvironment } from '@vscode/python-environments';

export interface PixiPythonEnvironment extends PythonEnvironment {
    pixiEnvName: string;
    pixiStatus: 'installed' | 'uninstalled' | 'incompatible';
    statusReason?: string;
    projectPath: string;
    projectName: string;
    manifestPath: string;
    hasIpykernel?: boolean;
}
