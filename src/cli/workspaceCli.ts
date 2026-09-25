import { CancellationError, ProgressLocation, Uri, window } from 'vscode';

import { PixiProjectManager } from '../core/projectManager';
import { runPixi } from './pixiCli';

export async function runPixiWithProgress(
    title: string,
    commandsToRun: string[] | string[][],
    cwd: string,
    manager: PixiProjectManager,
    successMsg: string | ((output: string) => string),
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
                let combinedOutput = '';
                for (const args of cmdList) {
                    const out = await runPixi(args, { cwd, includeStderr: true }, token);
                    combinedOutput += (combinedOutput ? '\n' : '') + out;
                }
                await manager.refresh(Uri.file(cwd));
                manager.clearPackagesCache(cwd);
                const finalSuccessMsg = typeof successMsg === 'function' ? successMsg(combinedOutput) : successMsg;
                window.showInformationMessage(finalSuccessMsg);
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
