import { Disposable } from 'vscode';

import { PixiProjectManager } from '../../core/projectManager';
import { PixiTaskProvider } from '../../providers/taskProvider';
import { registerChannelCommands } from './channelCommands';
import { registerEnvironmentCommands } from './environmentCommands';
import { registerPackageCommands } from './packageCommands';
import { registerTaskCommands } from './taskCommands';

export * from './channelCommands';
export * from './common';
export * from './environmentCommands';
export * from './packageCommands';
export * from './taskCommands';

export function registerWorkspaceCommands(manager: PixiProjectManager, taskProvider?: PixiTaskProvider): Disposable {
    const disposables: Disposable[] = [
        ...registerEnvironmentCommands(manager),
        ...registerPackageCommands(manager),
        ...registerChannelCommands(manager),
    ];

    if (taskProvider) {
        disposables.push(...registerTaskCommands(manager, taskProvider));
    }

    return Disposable.from(...disposables);
}
