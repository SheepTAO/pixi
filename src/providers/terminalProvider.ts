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

import { getPixi } from '../cli/pixiCli';
import { traceError, traceVerbose } from '../common/logging';
import { PixiProjectManager } from '../core/projectManager';
import { PixiEnvironmentInfo } from '../core/types';

interface EnvQuickPickItem extends QuickPickItem {
    env: PixiEnvironmentInfo;
}

export class PixiTerminalProvider implements TerminalProfileProvider, Disposable {
    private readonly disposables: Disposable[] = [];

    constructor(
        private readonly projectManager: PixiProjectManager,
        public readonly log?: LogOutputChannel,
    ) {
        this.disposables.push(window.registerTerminalProfileProvider('pixi.terminal', this));
        this.disposables.push(
            commands.registerCommand('pixi.openTerminal', async (target?: any) => {
                await this.openTerminal(target);
            }),
        );
    }

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async handleUninstalledOrError(env: PixiEnvironmentInfo): Promise<boolean> {
        if (env.pixiStatus === 'uninstalled') {
            const action = await window.showWarningMessage(
                `Environment '${env.pixiEnvName}' is not installed yet on disk. Would you like to install it now?`,
                'Install Environment',
            );
            if (action === 'Install Environment') {
                await commands.executeCommand('pixi.install', env.projectPath, env.pixiEnvName);
            }
            return true;
        }
        if (env.pixiStatus === 'incompatible') {
            const reason = env.statusReason || 'The environment is incompatible with the current platform.';
            window.showErrorMessage(`Cannot open terminal for environment '${env.pixiEnvName}': ${reason}`);
            return true;
        }
        return false;
    }

    private async pickEnvironment(token?: CancellationToken): Promise<PixiEnvironmentInfo | undefined> {
        const envs = this.projectManager.getAllEnvironments();
        if (!envs || envs.length === 0) {
            const choice = await window.showWarningMessage(
                'No Pixi environments found in current workspace. Would you like to initialize a Pixi project?',
                'Initialize Project',
            );
            if (choice === 'Initialize Project') {
                await commands.executeCommand('pixi.init');
            }
            return undefined;
        }

        if (envs.length === 1) {
            if (await this.handleUninstalledOrError(envs[0])) {
                return undefined;
            }
            return envs[0];
        }

        const items: EnvQuickPickItem[] = envs.map((env) => {
            let icon = '$(layers)';
            let statusText = '';
            if (env.pixiStatus === 'uninstalled') {
                icon = '$(cloud-download)';
                statusText = '(not installed)';
            } else if (env.pixiStatus === 'incompatible') {
                icon = '$(circle-slash)';
                statusText = '(incompatible)';
            }
            return {
                label: `${icon} ${env.pixiEnvName}`,
                description: statusText ? `${env.projectName} ${statusText}` : env.projectName,
                detail: env.statusReason || env.prefix,
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

        if (await this.handleUninstalledOrError(selected.env)) {
            return undefined;
        }

        return selected.env;
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

    async openTerminal(target?: PixiEnvironmentInfo | { env?: PixiEnvironmentInfo }): Promise<void> {
        try {
            let env: PixiEnvironmentInfo | undefined;
            if (target && 'pixiEnvName' in target) {
                env = target as PixiEnvironmentInfo;
            } else if (target && 'env' in target && target.env) {
                env = target.env;
            } else {
                env = await this.pickEnvironment();
            }
            if (!env) {
                return;
            }

            if (await this.handleUninstalledOrError(env)) {
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
