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
    Uri,
    window,
} from 'vscode';

import { traceError, traceVerbose } from '../common/logging';
import { getPixi } from './cli';
import { getEnvironmentQuickPickInfo } from './discovery';
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

        const handleUninstalledOrError = (env: PixiEnvironment): boolean => {
            if (!env.error) {
                return false;
            }
            const isUninstalled = env.pixiStatus === 'cache' || env.error.includes('not installed');
            if (isUninstalled) {
                const manifestPath = env.pixiInfo?.project_info?.manifest_path;
                const projectFolder = manifestPath ? Uri.file(path.dirname(manifestPath)) : undefined;
                void window
                    .showWarningMessage(
                        `Environment '${env.pixiEnvName}' is not installed yet on disk. Would you like to install it now?`,
                        'Install Environment',
                    )
                    .then((action) => {
                        if (action === 'Install Environment') {
                            void commands.executeCommand('pixi-python.install', projectFolder, env.pixiEnvName);
                        }
                    });
            } else {
                window.showErrorMessage(`Cannot open terminal for environment '${env.displayName}': ${env.error}`);
            }
            return true;
        };

        if (envs.length === 1) {
            if (handleUninstalledOrError(envs[0])) {
                return undefined;
            }
            return envs[0];
        }

        const items: EnvQuickPickItem[] = envs.map((env) => {
            const info = getEnvironmentQuickPickInfo(env);
            return {
                label: `${info.icon} ${env.pixiEnvName}`,
                description: info.statusText ? `${env.displayName} ${info.statusText}` : env.displayName,
                detail: env.error || env.displayPath,
                env,
            };
        });

        const selected = await window.showQuickPick(
            items,
            {
                placeHolder: 'Select a Pixi environment for the terminal',
                title: 'Pixi: Open Terminal',
            },
            token,
        );

        if (!selected) {
            return undefined;
        }

        if (handleUninstalledOrError(selected.env)) {
            return undefined;
        }

        return selected.env;
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
