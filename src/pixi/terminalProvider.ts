import * as path from 'path';
import {
    CancellationToken,
    commands,
    Disposable,
    LogOutputChannel,
    QuickPickItem,
    TerminalOptions,
    TerminalProfile,
    TerminalProfileProvider,
    ThemeIcon,
    window,
} from 'vscode';

import { traceError, traceVerbose } from '../common/logging';
import { getPixi } from './cli';
import { PixiEnvManager } from './envManager';
import { PixiEnvironment } from './types';

interface EnvQuickPickItem extends QuickPickItem {
    env: PixiEnvironment;
}

export class PixiTerminalProvider implements TerminalProfileProvider, Disposable {
    private readonly disposables: Disposable[] = [];

    constructor(
        private readonly envManager: PixiEnvManager,
        private readonly log: LogOutputChannel,
    ) {
        this.disposables.push(window.registerTerminalProfileProvider('pixi-python.terminal', this));
        this.disposables.push(
            commands.registerCommand('pixi-python.openTerminal', async () => {
                await this.openTerminal();
            }),
        );
    }

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async pickEnvironment(token?: CancellationToken): Promise<PixiEnvironment | undefined> {
        const envs = (await this.envManager.getEnvironments('all')) as PixiEnvironment[];
        if (!envs || envs.length === 0) {
            const choice = await window.showWarningMessage(
                'No Pixi environments found in current workspace. Would you like to initialize a Pixi project?',
                'Initialize Project',
            );
            if (choice === 'Initialize Project') {
                await commands.executeCommand('pixi-python.init');
            }
            return undefined;
        }

        if (envs.length === 1) {
            if (envs[0].error) {
                window.showErrorMessage(
                    `Cannot open terminal for environment '${envs[0].displayName}': ${envs[0].error}`,
                );
                return undefined;
            }
            return envs[0];
        }

        const items: EnvQuickPickItem[] = envs.map((env) => ({
            label: env.error ? `$(warning) ${env.pixiEnvName}` : `$(prefix-dev) ${env.pixiEnvName}`,
            description: env.error ? `${env.displayName} (unavailable)` : env.displayName,
            detail: env.error || env.displayPath,
            env,
        }));

        const selected = await window.showQuickPick(
            items,
            {
                placeHolder: 'Select a Pixi environment for the terminal',
                title: 'Pixi: Open Terminal',
            },
            token,
        );

        if (selected?.env.error) {
            window.showErrorMessage(
                `Cannot open terminal for environment '${selected.env.displayName}': ${selected.env.error}`,
            );
            return undefined;
        }

        return selected?.env;
    }

    private async createTerminalOptions(env: PixiEnvironment): Promise<TerminalOptions> {
        const pixi = await getPixi();
        const manifestPath = env.pixiInfo.project_info?.manifest_path;
        const cwd = manifestPath ? path.dirname(manifestPath) : undefined;
        const args = ['shell'];
        if (manifestPath) {
            args.push('--manifest-path', manifestPath);
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
            const env = await this.pickEnvironment(token);
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

    async openTerminal(): Promise<void> {
        try {
            const env = await this.pickEnvironment();
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
