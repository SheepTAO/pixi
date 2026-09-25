import { CancellationError, ProgressLocation, Uri, window } from 'vscode';

import { PixiProjectManager } from '../core/projectManager';
import { runPixi } from './pixiCli';

export async function runPixiWithProgress(
    title: string,
    commandsToRun: string[] | string[][],
    cwd: string,
    manager: PixiProjectManager,
    successMsg: string,
): Promise<boolean> {
    const cmdList: string[][] = Array.isArray(commandsToRun[0])
        ? (commandsToRun as string[][])
        : [commandsToRun as string[]];
    try {
        await window.withProgress(
            {
                location: ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress, token) => {
                for (const args of cmdList) {
                    await runPixi(args, { cwd }, token);
                }
                await manager.refresh(Uri.file(cwd));
                manager.clearPackagesCache(cwd);
                window.showInformationMessage(successMsg);
            },
        );
        return true;
    } catch (error) {
        if (error instanceof CancellationError) {
            return false;
        }
        window.showErrorMessage(error instanceof Error ? error.message : String(error));
        return false;
    }
}
