import { Uri } from 'vscode';

import { runWithProgressNotification } from '../common/execUtils';
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
    return runWithProgressNotification(
        title,
        async (token) => {
            let combinedOutput = '';
            for (const args of cmdList) {
                const out = await runPixi(args, { cwd, includeStderr: true }, token);
                combinedOutput += (combinedOutput ? '\n' : '') + out;
            }
            await manager.refresh(Uri.file(cwd));
            return combinedOutput;
        },
        successMsg,
    );
}
