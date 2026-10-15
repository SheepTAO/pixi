import {
    CancellationError,
    commands,
    Disposable,
    env as vscodeEnv,
    ProgressLocation,
    QuickPickItem,
    Uri,
    window,
} from 'vscode';

import {
    getPixiAuthStatus,
    getPixiAuthToken,
    isTokenAuthMethod,
    loginPixiHost,
    loginPixiHostOAuth,
    logoutPixiHost,
    readStoredCredentials,
    StoredAuthEntry,
} from '../cli/authCli';
import { runWithProgressNotification } from '../common/execUtils';
import { PixiInfoTreeDataProvider } from '../views/infoTreeDataProvider';

interface HostPresetItem extends QuickPickItem {
    host?: string;
    isCustom?: boolean;
}

const DEFAULT_HOST_PRESETS: HostPresetItem[] = [
    {
        label: '$(cloud) prefix.dev',
        description: 'Official Prefix.dev cloud platform',
        detail: 'Prefix.dev public and private channels',
        host: 'prefix.dev',
    },
    {
        label: '$(server) anaconda.org',
        description: 'Anaconda.org repository',
        detail: 'Anaconda.org public and private channels',
        host: 'anaconda.org',
    },
    {
        label: '$(server) conda.anaconda.org',
        description: 'Conda Anaconda server',
        detail: 'Default Conda package host for Anaconda channels',
        host: 'conda.anaconda.org',
    },
    {
        label: '$(globe) Custom Host / Enterprise Registry...',
        description: 'Specify custom server domain or internal mirror',
        detail: 'e.g. packages.mycorp.com, jfrog.internal.org, quetz.server.net',
        isCustom: true,
    },
];

function normalizeHost(input: string): string {
    let cleaned = input.trim();
    cleaned = cleaned.replace(/^https?:\/\//i, '');
    cleaned = cleaned.replace(/\/+.*$/, '');
    return cleaned.trim();
}

function validateRequired(fieldName: string): (value: string) => string | null {
    return (v) => (!v.trim() ? `${fieldName} cannot be empty` : null);
}

function extractHostFromTarget(target?: unknown): string | undefined {
    if (!target) {
        return undefined;
    }
    if (typeof target === 'string') {
        return target.trim();
    }
    if (typeof target === 'object' && target !== null) {
        const obj = target as { hostPattern?: string };
        if (typeof obj.hostPattern === 'string' && obj.hostPattern.trim()) {
            return obj.hostPattern.trim();
        }
    }
    return undefined;
}

export async function promptLogin(infoProvider: PixiInfoTreeDataProvider, defaultHost?: string): Promise<void> {
    let targetHost = defaultHost;

    if (!targetHost) {
        const picked = await window.showQuickPick(DEFAULT_HOST_PRESETS, {
            title: 'Pixi: Login to Host / Channel',
            placeHolder: 'Select a host to authenticate with or enter a custom registry',
        });
        if (!picked) {
            return;
        }

        if (picked.isCustom) {
            const customInput = await window.showInputBox({
                title: 'Pixi: Enter Registry Host',
                prompt: 'Enter hostname to authenticate with (e.g. packages.mycorp.com or prefix.dev)',
                placeHolder: 'packages.mycorp.com',
                ignoreFocusOut: true,
                validateInput: (val) => {
                    const norm = normalizeHost(val);
                    if (!norm) {
                        return 'Host cannot be empty';
                    }
                    return null;
                },
            });
            if (!customInput) {
                return;
            }
            targetHost = normalizeHost(customInput);
        } else {
            targetHost = picked.host;
        }
    }

    if (!targetHost) {
        return;
    }

    interface MethodPickItem extends QuickPickItem {
        method: 'token' | 'conda-token' | 'basic' | 's3' | 'oauth';
    }

    const isPrefix = targetHost === 'prefix.dev' || targetHost.endsWith('.prefix.dev');
    const isAnaconda = targetHost === 'anaconda.org' || targetHost === 'conda.anaconda.org';

    const methods: MethodPickItem[] = [];

    if (isPrefix) {
        methods.push(
            {
                label: '$(key) Bearer Token (Recommended)',
                description: 'Personal Access Token from prefix.dev/settings/tokens',
                method: 'token',
            },
            {
                label: '$(browser) OAuth / SSO Sign-in',
                description: 'Interactive browser sign-in via terminal',
                method: 'oauth',
            },
        );
    } else if (isAnaconda) {
        methods.push(
            {
                label: '$(key) Conda Token',
                description: 'API token generated in Anaconda.org account settings',
                method: 'conda-token',
            },
            {
                label: '$(lock) Basic HTTP (Username & Password)',
                description: 'Standard HTTP Basic authentication',
                method: 'basic',
            },
        );
    } else {
        methods.push(
            {
                label: '$(key) Bearer Token',
                description: 'HTTP Bearer token header',
                method: 'token',
            },
            {
                label: '$(lock) Basic HTTP (Username & Password)',
                description: 'Standard HTTP basic authentication (Artifactory, Nexus)',
                method: 'basic',
            },
            {
                label: '$(key) Conda Token',
                description: 'Conda repository token (Anaconda / Quetz)',
                method: 'conda-token',
            },
            {
                label: '$(cloud) AWS S3 Credentials',
                description: 'S3 Access Key ID & Secret Access Key for S3 channels',
                method: 's3',
            },
            {
                label: '$(browser) OAuth / OIDC',
                description: 'Interactive device code or browser flow',
                method: 'oauth',
            },
        );
    }

    const selectedMethod = await window.showQuickPick(methods, {
        title: `Pixi: Authentication Method for '${targetHost}'`,
        placeHolder: 'Select an authentication method',
    });
    if (!selectedMethod) {
        return;
    }

    if (selectedMethod.method === 'oauth') {
        const hostToAuth = targetHost;
        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Pixi: OAuth sign-in with '${hostToAuth}'`,
                    cancellable: true,
                },
                async (progress, cancellationToken) => {
                    progress.report({ message: 'Requesting authentication link...' });
                    let linkOpened = false;

                    await loginPixiHostOAuth(
                        hostToAuth,
                        async (details) => {
                            if (linkOpened) {
                                return;
                            }
                            linkOpened = true;

                            progress.report({
                                message: details.userCode
                                    ? `Waiting for browser authorization (Code: ${details.userCode})...`
                                    : 'Waiting for browser authorization...',
                            });

                            if (details.userCode) {
                                await vscodeEnv.clipboard.writeText(details.userCode);
                            }

                            try {
                                await vscodeEnv.openExternal(Uri.parse(details.verificationUri));
                            } catch {
                                // Ignore browser open failure
                            }

                            const promptMsg = details.userCode
                                ? `Pixi OAuth: Code "${details.userCode}" copied to clipboard. Please confirm authorization in the opened browser window.`
                                : 'Pixi OAuth: Please confirm authorization in the opened browser window.';

                            void window.showInformationMessage(promptMsg, 'Open Browser').then((action) => {
                                if (action === 'Open Browser') {
                                    void vscodeEnv.openExternal(Uri.parse(details.verificationUri));
                                }
                            });
                        },
                        cancellationToken,
                    );

                    infoProvider.refresh();
                    window.showInformationMessage(`Successfully authenticated with '${hostToAuth}' via OAuth.`);
                },
            );
        } catch (err) {
            if (err instanceof CancellationError) {
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            window.showErrorMessage(`Failed to authenticate with '${hostToAuth}' via OAuth: ${msg}`);
        }
        return;
    }

    let token: string | undefined;
    let condaToken: string | undefined;
    let username: string | undefined;
    let password: string | undefined;
    let s3AccessKeyId: string | undefined;
    let s3SecretAccessKey: string | undefined;
    let s3SessionToken: string | undefined;

    if (selectedMethod.method === 'token') {
        token = await window.showInputBox({
            title: `Pixi Auth: Bearer Token (${targetHost})`,
            prompt: `Enter authentication token for '${targetHost}'`,
            password: true,
            ignoreFocusOut: true,
            validateInput: validateRequired('Token'),
        });
        if (!token) {
            return;
        }
    } else if (selectedMethod.method === 'conda-token') {
        condaToken = await window.showInputBox({
            title: `Pixi Auth: Conda Token (${targetHost})`,
            prompt: `Enter Conda token for '${targetHost}'`,
            password: true,
            ignoreFocusOut: true,
            validateInput: validateRequired('Token'),
        });
        if (!condaToken) {
            return;
        }
    } else if (selectedMethod.method === 'basic') {
        username = await window.showInputBox({
            title: `Pixi Auth: Username (${targetHost})`,
            prompt: `Enter username for '${targetHost}'`,
            ignoreFocusOut: true,
            validateInput: validateRequired('Username'),
        });
        if (!username) {
            return;
        }

        password = await window.showInputBox({
            title: `Pixi Auth: Password (${targetHost})`,
            prompt: `Enter password for user '${username}' on '${targetHost}'`,
            password: true,
            ignoreFocusOut: true,
            validateInput: validateRequired('Password'),
        });
        if (!password) {
            return;
        }
    } else if (selectedMethod.method === 's3') {
        s3AccessKeyId = await window.showInputBox({
            title: `Pixi Auth: S3 Access Key ID (${targetHost})`,
            prompt: 'Enter S3 Access Key ID',
            ignoreFocusOut: true,
            validateInput: validateRequired('Access Key ID'),
        });
        if (!s3AccessKeyId) {
            return;
        }

        s3SecretAccessKey = await window.showInputBox({
            title: `Pixi Auth: S3 Secret Access Key (${targetHost})`,
            prompt: 'Enter S3 Secret Access Key',
            password: true,
            ignoreFocusOut: true,
            validateInput: validateRequired('Secret Access Key'),
        });
        if (!s3SecretAccessKey) {
            return;
        }

        s3SessionToken = await window.showInputBox({
            title: `Pixi Auth: S3 Session Token (${targetHost})`,
            prompt: 'Enter S3 Session Token (optional, press Enter to skip)',
            password: true,
            ignoreFocusOut: true,
        });
    }

    const hostToAuth = targetHost;
    await runWithProgressNotification(
        `Pixi: Authenticating with '${hostToAuth}'...`,
        async () => {
            await loginPixiHost({
                host: hostToAuth,
                method: selectedMethod.method,
                token,
                condaToken,
                username,
                password,
                s3AccessKeyId,
                s3SecretAccessKey,
                s3SessionToken,
            });
            infoProvider.refresh();
        },
        `Pixi: Successfully authenticated with '${hostToAuth}'.`,
        { errorPrefix: `Failed to authenticate with '${hostToAuth}'`, cancellable: false },
    );
}

export async function promptLogout(infoProvider: PixiInfoTreeDataProvider, targetItem?: unknown): Promise<void> {
    const directHost = extractHostFromTarget(targetItem);

    if (directHost) {
        const confirm = await window.showWarningMessage(
            `Are you sure you want to remove stored authentication for "${directHost}"?`,
            { modal: true },
            'Logout',
        );
        if (confirm !== 'Logout') {
            return;
        }

        await runWithProgressNotification(
            `Pixi: Removing authentication for '${directHost}'...`,
            async () => {
                await logoutPixiHost(directHost);
                infoProvider.refresh();
            },
            `Pixi: Removed authentication for '${directHost}'.`,
            { errorPrefix: `Failed to remove authentication for '${directHost}'` },
        );
        return;
    }

    const entries = await readStoredCredentials();
    if (entries.length === 0) {
        window.showInformationMessage('No stored authentication entries found.');
        return;
    }

    interface LogoutItem extends QuickPickItem {
        host?: string;
        isAll?: boolean;
    }

    const items: LogoutItem[] = [
        ...entries.map((e) => ({
            label: `$(shield) ${e.hostPattern}`,
            description: `[${e.method}]${e.username ? ` (${e.username})` : ''}`,
            host: e.hostPattern,
        })),
        {
            label: '$(trash) Logout from All Hosts',
            description: 'Remove all stored credentials (--all)',
            isAll: true,
        },
    ];

    const picked = await window.showQuickPick(items, {
        title: 'Pixi: Logout from Host / Registry',
        placeHolder: 'Select host to remove authentication for',
    });
    if (!picked) {
        return;
    }

    if (picked.isAll) {
        const confirmAll = await window.showWarningMessage(
            'Are you sure you want to remove all stored authentication entries from Pixi?',
            { modal: true },
            'Logout All',
        );
        if (confirmAll !== 'Logout All') {
            return;
        }

        await runWithProgressNotification(
            'Pixi: Removing all stored authentication entries...',
            async () => {
                await logoutPixiHost(undefined, true);
                infoProvider.refresh();
            },
            'Pixi: All authentication entries removed.',
            { errorPrefix: 'Failed to logout from all hosts' },
        );
        return;
    }

    if (picked.host) {
        const target = picked.host;
        const confirm = await window.showWarningMessage(
            `Are you sure you want to remove stored authentication for "${target}"?`,
            { modal: true },
            'Logout',
        );
        if (confirm !== 'Logout') {
            return;
        }

        await runWithProgressNotification(
            `Pixi: Removing authentication for '${target}'...`,
            async () => {
                await logoutPixiHost(target);
                infoProvider.refresh();
            },
            `Pixi: Removed authentication for '${target}'.`,
            { errorPrefix: `Failed to remove authentication for '${target}'` },
        );
    }
}

export async function promptCopyToken(targetItem?: unknown): Promise<void> {
    let targetHost = extractHostFromTarget(targetItem);

    if (!targetHost) {
        const entries = await readStoredCredentials();
        const tokenEntries = entries.filter((e) => isTokenAuthMethod(e.method));
        if (tokenEntries.length === 0) {
            window.showInformationMessage(
                entries.length === 0
                    ? 'No stored authentication entries found.'
                    : 'None of the stored authentication entries have a copyable token.',
            );
            return;
        }

        const picked = await window.showQuickPick(
            tokenEntries.map((e) => ({
                label: `$(key) ${e.hostPattern}`,
                description: `[${e.method}]`,
                host: e.hostPattern,
            })),
            {
                title: 'Pixi: Copy Authentication Token',
                placeHolder: 'Select a host to copy token for',
            },
        );
        if (!picked) {
            return;
        }
        targetHost = picked.host;
    }

    if (!targetHost) {
        return;
    }

    try {
        const token = await getPixiAuthToken(targetHost);
        if (!token) {
            window.showWarningMessage(`No token returned for host '${targetHost}'.`);
            return;
        }
        await vscodeEnv.clipboard.writeText(token);
        window.showInformationMessage(`Authentication token for '${targetHost}' copied to clipboard.`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        window.showErrorMessage(`Failed to get authentication token for '${targetHost}': ${msg}`);
    }
}

export async function showAuthStatus(): Promise<void> {
    try {
        const status = await getPixiAuthStatus();
        const entries = await readStoredCredentials();

        if (entries.length === 0) {
            const action = await window.showInformationMessage(
                'No stored Pixi authentication entries found.',
                'Login to Host...',
            );
            if (action === 'Login to Host...') {
                await commands.executeCommand('pixi.auth.login');
            }
            return;
        }

        const lines = [
            `Pixi Stored Authentication Entries (${entries.length} hosts):`,
            ...entries.map((e) => `  • ${e.hostPattern} [${e.method}]${e.username ? ` (${e.username})` : ''}`),
            '',
            status,
        ];

        window.showInformationMessage(lines.join('\n'), { modal: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        window.showErrorMessage(`Failed to check authentication status: ${msg}`);
    }
}

export async function showAuthHub(infoProvider: PixiInfoTreeDataProvider): Promise<void> {
    const entries: StoredAuthEntry[] = await readStoredCredentials();

    interface AuthActionItem extends QuickPickItem {
        action: 'login' | 'logout' | 'copyToken' | 'status';
    }

    const items: AuthActionItem[] = [
        {
            label: '$(sign-in) Login to Host / Registry...',
            description: 'Authenticate with prefix.dev, anaconda.org, or custom registry (pixi auth login)',
            action: 'login',
        },
        {
            label: '$(sign-out) Logout from Host...',
            description: 'Remove stored authentication credentials for a host (pixi auth logout)',
            action: 'logout',
        },
        {
            label: '$(key) Copy Token for Host...',
            description: 'Copy stored bearer or Conda token to clipboard (pixi auth token)',
            action: 'copyToken',
        },
        {
            label: '$(info) View Authentication Status',
            description: `Inspect stored credential entries (${entries.length} active)`,
            action: 'status',
        },
    ];

    const pick = await window.showQuickPick(items, {
        title: 'Pixi: Authentication Management (pixi auth)',
        placeHolder: 'Select an authentication operation',
    });
    if (!pick) {
        return;
    }

    switch (pick.action) {
        case 'login':
            await promptLogin(infoProvider);
            break;
        case 'logout':
            await promptLogout(infoProvider);
            break;
        case 'copyToken':
            await promptCopyToken();
            break;
        case 'status':
            await showAuthStatus();
            break;
    }
}

export function registerAuthCommands(infoProvider: PixiInfoTreeDataProvider): Disposable {
    const disposables: Disposable[] = [
        commands.registerCommand('pixi.auth', async () => {
            await showAuthHub(infoProvider);
        }),
        commands.registerCommand('pixi.auth.login', async (host?: string) => {
            await promptLogin(infoProvider, typeof host === 'string' ? host : undefined);
        }),
        commands.registerCommand('pixi.auth.logout', async (targetItem?: unknown) => {
            await promptLogout(infoProvider, targetItem);
        }),
        commands.registerCommand('pixi.auth.copyToken', async (targetItem?: unknown) => {
            await promptCopyToken(targetItem);
        }),
        commands.registerCommand('pixi.auth.status', async () => {
            await showAuthStatus();
        }),
    ];

    return Disposable.from(...disposables);
}
