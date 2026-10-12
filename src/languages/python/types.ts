import { PythonEnvironment } from '@vscode/python-environments';

import { PixiEnvironmentStatus } from '../../core/types';

export interface PixiPythonEnvironment extends PythonEnvironment {
    pixiEnvName: string;
    pixiStatus: PixiEnvironmentStatus;
    statusReason?: string;
    projectPath: string;
    projectName: string;
    manifestPath: string;
    hasIpykernel?: boolean;
}
