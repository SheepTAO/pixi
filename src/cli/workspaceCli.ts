import {
    CancellationToken,
    ShellExecution,
    Task,
    TaskDefinition,
    TaskExecution,
    TaskPanelKind,
    TaskRevealKind,
    tasks,
    TaskScope,
    Uri,
    window,
    workspace,
} from 'vscode';

import { quoteArgs, quoteStringIfNecessary, runWithProgressNotification } from '../common/execUtils';
import { PixiProjectManager } from '../core/projectManager';
import { getPixi, runPixi } from './pixiCli';

export type ExecutionMode = 'smart' | 'terminal' | 'notification';

/**
 * Determines whether a Pixi command is a heavy/long-running operation that
 * involves package downloads, network requests, or environment solving.
 */
export function isHeavyPixiCommand(args: string[]): boolean {
    if (!args || args.length === 0) {
        return false;
    }
    const subCmd = args.find((arg) => !arg.startsWith('-'))?.toLowerCase();
    if (!subCmd) {
        return false;
    }
    return ['add', 'install', 'update', 'upgrade', 'reinstall', 'import'].includes(subCmd);
}

/**
 * Executes a Pixi command inside a VS Code integrated terminal Task, providing
 * full interactive PTY terminal support (native multi-line progress bars, download speeds, etc.).
 */
async function runPixiCommandInTerminal(
    args: string[],
    cwd: string,
    title: string,
    token?: CancellationToken,
): Promise<number | undefined> {
    if (token?.isCancellationRequested) {
        return undefined;
    }

    const pixiBin = await getPixi();
    const parts = [quoteStringIfNecessary(pixiBin), ...quoteArgs(args)];
    const commandLine = parts.join(' ');

    const taskName = title.startsWith('Pixi: ') ? title.slice(6).trim() : title;
    const scope = workspace.getWorkspaceFolder(Uri.file(cwd)) || TaskScope.Workspace;
    const def: TaskDefinition = { type: 'pixi', task: taskName, project: cwd };
    const task = new Task(def, scope, taskName, 'pixi', new ShellExecution(commandLine, { cwd }));
    task.presentationOptions = {
        reveal: TaskRevealKind.Always,
        focus: false,
        panel: TaskPanelKind.Shared,
        showReuseMessage: true,
        clear: false,
    };

    return new Promise<number | undefined>((resolve, reject) => {
        let execution: TaskExecution | undefined;
        let finished = false;

        const cleanup = () => {
            if (!finished) {
                finished = true;
                procSub.dispose();
                endSub.dispose();
                cancelSub?.dispose();
            }
        };

        const procSub = tasks.onDidEndTaskProcess((e) => {
            if ((execution && e.execution === execution) || e.execution.task === task) {
                cleanup();
                resolve(e.exitCode);
            }
        });

        const endSub = tasks.onDidEndTask((e) => {
            if ((execution && e.execution === execution) || e.execution.task === task) {
                cleanup();
                resolve(undefined);
            }
        });

        const cancelSub = token?.onCancellationRequested(() => {
            execution?.terminate();
        });

        tasks.executeTask(task).then(
            (exec) => {
                execution = exec;
            },
            (err) => {
                cleanup();
                reject(err);
            },
        );
    });
}

/**
 * Unified gateway to execute workspace-modifying Pixi commands.
 * Automatically selects between terminal execution and notification progress
 * based on user setting `pixi.executionMode` ('smart', 'terminal', or 'notification').
 *
 * Always refreshes the PixiProjectManager tree on success. In terminal mode, avoids
 * redundant success toasts since results are already visible in the terminal.
 */
export async function runPixiWithProgress(
    title: string,
    commandsToRun: string[] | string[][],
    cwd: string,
    manager: PixiProjectManager,
    successMsg: string | ((output: string) => string),
    token?: CancellationToken,
): Promise<boolean> {
    const cmdList: string[][] = Array.isArray(commandsToRun[0])
        ? (commandsToRun as string[][])
        : [commandsToRun as string[]];

    const config = workspace.getConfiguration('pixi', cwd ? Uri.file(cwd) : undefined);
    const mode = config.get<ExecutionMode>('executionMode', 'smart') || 'smart';

    const shouldRunInTerminal = mode === 'terminal' || (mode === 'smart' && cmdList.some(isHeavyPixiCommand));

    if (shouldRunInTerminal) {
        try {
            for (const args of cmdList) {
                const exitCode = await runPixiCommandInTerminal(args, cwd, title, token);
                if (exitCode !== 0) {
                    return false;
                }
            }
            await manager.refresh(Uri.file(cwd));
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            window.showErrorMessage(`Failed to execute Pixi command in terminal: ${msg}`);
            return false;
        }
    }

    return runWithProgressNotification(
        title,
        async (actionToken) => {
            let combinedOutput = '';
            for (const args of cmdList) {
                const out = await runPixi(args, { cwd, includeStderr: true }, actionToken);
                combinedOutput += (combinedOutput ? '\n' : '') + out;
            }
            await manager.refresh(Uri.file(cwd));
            return combinedOutput;
        },
        successMsg,
    );
}
