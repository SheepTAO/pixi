import {
    CancellationToken,
    commands,
    Disposable,
    TerminalOptions,
    TerminalProfile,
    TerminalProfileProvider,
    ThemeIcon,
    window,
} from 'vscode';

import { getPixi } from '../cli/pixiCli';
import { resolveReadyEnvironment } from '../commands/workspace/common';
import { traceError, traceVerbose } from '../common/logging';
import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo } from '../core/types';

export class PixiTerminalProvider implements TerminalProfileProvider, Disposable {
    private readonly disposables: Disposable[] = [];

    constructor(private readonly projectManager: PixiProjectManager) {
        this.disposables.push(
            window.registerTerminalProfileProvider('pixi.terminal', this),
            commands.registerCommand('pixi.openTerminal', async (target?: unknown) => {
                await this.openTerminal(target);
            }),
        );
    }

    public dispose(): void {
        Disposable.from(...this.disposables).dispose();
    }

    private async createTerminalOptions(env: PixiEnvironmentInfo): Promise<TerminalOptions> {
        const pixi = await getPixi();
        const cwd = env.projectPath;
        const args = ['shell'];
        if (env.manifestPath) {
            args.push('--manifest-path', env.manifestPath);
        }
        args.push('-e', env.pixiEnvName);

        return {
            name: `Pixi: ${env.pixiEnvName}`,
            shellPath: pixi,
            shellArgs: args,
            cwd,
            iconPath: new ThemeIcon('prefix-dev'),
        };
    }

    async provideTerminalProfile(token: CancellationToken): Promise<TerminalProfile | undefined> {
        traceVerbose('Terminal profile requested for Pixi');
        try {
            const env = await resolveReadyEnvironment(this.projectManager, undefined, {
                action: 'open terminal for environment',
                title: 'Pixi: Open Terminal',
                placeHolder: 'Select a Pixi environment for the terminal',
                defaultEnvConfigKey: 'terminal.defaultEnvironment',
                token,
            });
            if (!env) {
                return undefined;
            }

            const options = await this.createTerminalOptions(env);
            return new TerminalProfile(options);
        } catch (error) {
            traceError(`Failed to provide Pixi terminal profile: ${error}`);
            return undefined;
        }
    }

    async openTerminal(target?: unknown): Promise<void> {
        try {
            const env = await resolveReadyEnvironment(this.projectManager, target, {
                action: 'open terminal for environment',
                title: 'Pixi: Open Terminal',
                placeHolder: 'Select a Pixi environment for the terminal',
                defaultEnvConfigKey: 'terminal.defaultEnvironment',
            });
            if (!env) {
                return;
            }

            const options = await this.createTerminalOptions(env);
            const terminal = window.createTerminal(options);
            terminal.show();
        } catch (error) {
            traceError(`Failed to open Pixi terminal: ${error}`);
            window.showErrorMessage(`Failed to open Pixi terminal: ${error}`);
        }
    }
}
