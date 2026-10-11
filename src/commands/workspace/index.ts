import { Disposable } from 'vscode';

import { PixiProjectManager } from '../../core/projectManager';
import { PixiTaskProvider } from '../../providers/taskProvider';
import { registerChannelCommands } from './channelCommands';
import { registerEnvironmentCommands } from './environmentCommands';
import { registerPackageCommands } from './packageCommands';
import { registerTaskCommands } from './taskCommands';
import { registerUpdateCommands } from './updateCommands';

export function registerWorkspaceCommands(manager: PixiProjectManager, taskProvider: PixiTaskProvider): Disposable {
    return Disposable.from(
        ...registerEnvironmentCommands(manager),
        ...registerPackageCommands(manager),
        ...registerChannelCommands(manager),
        ...registerUpdateCommands(manager),
        ...registerTaskCommands(manager, taskProvider),
    );
}
