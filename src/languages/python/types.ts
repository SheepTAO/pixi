import { Package, PythonEnvironment } from '@vscode/python-environments';

import { PixiEnvironmentInfo } from '../../core/types';

export interface PixiPythonEnvironment extends PythonEnvironment {
    pixiEnvName: string;
    pixiStatus: 'installed' | 'uninstalled' | 'incompatible';
    statusReason?: string;
    packages: Package[];
    projectPath: string;
    projectName: string;
    manifestPath: string;
    coreInfo: PixiEnvironmentInfo;
}
