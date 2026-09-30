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
    workspace,
} from 'vscode';

import { getPixi } from '../cli/pixiCli';
import { normalizeFolderPath } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { getEnvironmentStatusBadge, promptToInstallEnvironment, sortPixiEnvironments } from '../core/environmentRules';
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
    }

    public registerCommands(): Disposable {
        return commands.registerCommand('pixi.openTerminal', async (target?: unknown) => {
            await this.openTerminal(target);
        });
    }

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async handleUninstalledOrError(env: PixiEnvironmentInfo): Promise<boolean> {
        if (env.pixiStatus === 'uninstalled') {
            await promptToInstallEnvironment(env.pixiEnvName, env.projectPath);
            return true;
        }
        if (env.pixiStatus === 'incompatible') {
            const reason = env.statusReason || 'The environment is incompatible with the current platform.';
            window.showErrorMessage(`Cannot open terminal for environment '${env.pixiEnvName}': ${reason}`);
            return true;
        }
        return false;
    }

    private async pickEnvironment(
        token?: CancellationToken,
        targetProjectPath?: string,
    ): Promise<PixiEnvironmentInfo | undefined> {
        const rawEnvs = targetProjectPath
            ? this.projectManager.getEnvironmentsForProject(targetProjectPath)
            : this.projectManager.getAllEnvironments();
        if (!rawEnvs || rawEnvs.length === 0) {
            const choice = await window.showWarningMessage(
                'No Pixi environments found in current workspace. Would you like to initialize a Pixi project?',
                'Initialize Project',
            );
            if (choice === 'Initialize Project') {
                await commands.executeCommand('pixi.init');
            }
            return undefined;
        }

        const envs = sortPixiEnvironments(rawEnvs);

        if (envs.length === 1) {
            if (await this.handleUninstalledOrError(envs[0])) {
                return undefined;
            }
            return envs[0];
        }

        const activeUri = window.activeTextEditor?.document?.uri;
        const configScope = targetProjectPath ? Uri.file(targetProjectPath) : activeUri;
        const config = workspace.getConfiguration('pixi', configScope);
        const defaultEnvSetting = config.get<string>('terminal.defaultEnvironment')?.trim();

        if (defaultEnvSetting) {
            let matchedEnv: PixiEnvironmentInfo | undefined;
            if (targetProjectPath) {
                matchedEnv = envs.find((e) => e.pixiEnvName === defaultEnvSetting);
            } else if (activeUri) {
                const projectPath = this.projectManager.findProjectForUri(activeUri);
                if (projectPath) {
                    const projectEnvs = this.projectManager.getEnvironmentsForProject(projectPath);
                    matchedEnv = projectEnvs.find((e) => e.pixiEnvName === defaultEnvSetting);
                }
            }
            if (!matchedEnv) {
                const matching = envs.filter((e) => e.pixiEnvName === defaultEnvSetting);
                if (matching.length === 1) {
                    matchedEnv = matching[0];
                }
            }
            if (matchedEnv) {
                if (await this.handleUninstalledOrError(matchedEnv)) {
                    return undefined;
                }
                return matchedEnv;
            }
        }

        const items: EnvQuickPickItem[] = envs.map((env) => {
            const { icon, text } = getEnvironmentStatusBadge(env.pixiStatus);
            return {
                label: `${icon} ${env.pixiEnvName}`,
                description: text ? `${env.projectName} ${text}` : env.projectName,
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

    async openTerminal(target?: unknown): Promise<void> {
        try {
            const candidate =
                (target as { env?: PixiEnvironmentInfo })?.env ?? (target as PixiEnvironmentInfo | undefined);
            let env = candidate && typeof candidate.pixiEnvName === 'string' ? candidate : undefined;

            const folder = normalizeFolderPath(target);
            const targetProjectPath = folder
                ? this.projectManager.findProjectForUri(Uri.file(folder)) || folder
                : undefined;

            if (!env) {
                env = await this.pickEnvironment(undefined, targetProjectPath);
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
