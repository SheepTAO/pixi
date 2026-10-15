import * as ch from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CancellationError, CancellationToken, workspace } from 'vscode';

import { safeJsonParse, sanitizeArgsForLogging } from '../common/execUtils';
import { traceError } from '../common/logging';
import { getPixi, resolveSpawnArgs, runPixi } from './pixiCli';

export type AuthMethod = 'BearerToken' | 'CondaToken' | 'BasicHTTP' | 'S3' | 'OAuth2' | 'Unknown';

export interface StoredAuthEntry {
    hostPattern: string;
    method: AuthMethod;
    username?: string;
    raw?: unknown;
}

export interface LoginOptions {
    host: string;
    method: 'token' | 'conda-token' | 'basic' | 's3' | 'oauth';
    token?: string;
    condaToken?: string;
    username?: string;
    password?: string;
    s3AccessKeyId?: string;
    s3SecretAccessKey?: string;
    s3SessionToken?: string;
}

export interface OAuthPromptDetails {
    verificationUri: string;
    userCode?: string;
}

let _cachedAuthDir: string | undefined;

/**
 * Updates the globally discovered credentials directory or file path.
 */
export function setCachedAuthDir(dir?: string): void {
    if (dir) {
        _cachedAuthDir = dir;
    }
}

/**
 * Resolves the credentials.json path from an optional authDir, cached dir, or system default (~/.rattler/credentials.json).
 */
export function resolveCredentialsPath(authDir?: string): string {
    const targetDir = authDir || _cachedAuthDir;
    if (targetDir) {
        try {
            if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
                return path.join(targetDir, 'credentials.json');
            }
        } catch {
            // fallback
        }
        return targetDir;
    }
    return path.join(os.homedir(), '.rattler', 'credentials.json');
}

/**
 * Asynchronously reads stored authentication entries from credentials.json.
 */
export async function readStoredCredentials(authDir?: string): Promise<StoredAuthEntry[]> {
    const credPath = resolveCredentialsPath(authDir);
    try {
        if (!fs.existsSync(credPath)) {
            return [];
        }
        const text = await fs.promises.readFile(credPath, 'utf8');
        const data = safeJsonParse<Record<string, Record<string, unknown>>>(text, {});
        const entries: StoredAuthEntry[] = [];

        for (const [hostPattern, value] of Object.entries(data)) {
            if (!value || typeof value !== 'object') {
                continue;
            }
            let method: AuthMethod = 'Unknown';
            let username: string | undefined;

            if ('BearerToken' in value) {
                method = 'BearerToken';
            } else if ('CondaToken' in value) {
                method = 'CondaToken';
            } else if ('BasicHTTP' in value) {
                method = 'BasicHTTP';
                const basic = value.BasicHTTP as { username?: string };
                username = basic?.username;
            } else if ('S3' in value) {
                method = 'S3';
                const s3 = value.S3 as { access_key_id?: string };
                username = s3?.access_key_id;
            } else if ('OAuth2' in value) {
                method = 'OAuth2';
            }

            entries.push({
                hostPattern,
                method,
                username,
                raw: value,
            });
        }

        return entries.sort((a, b) => a.hostPattern.localeCompare(b.hostPattern));
    } catch {
        return [];
    }
}

/**
 * Log in to a given host using token, basic auth, or S3 credentials.
 */
export async function loginPixiHost(options: LoginOptions): Promise<string> {
    const args = ['auth', 'login', options.host, '--no-progress'];

    if (options.method === 'token' && options.token) {
        args.push('--token', options.token);
    } else if (options.method === 'conda-token' && options.condaToken) {
        args.push('--conda-token', options.condaToken);
    } else if (options.method === 'basic' && options.username && options.password) {
        args.push('--username', options.username, '--password', options.password);
    } else if (options.method === 's3' && options.s3AccessKeyId && options.s3SecretAccessKey) {
        args.push('--s3-access-key-id', options.s3AccessKeyId, '--s3-secret-access-key', options.s3SecretAccessKey);
        if (options.s3SessionToken) {
            args.push('--s3-session-token', options.s3SessionToken);
        }
    }

    return runPixi(args, { includeStderr: true });
}

/**
 * Log in to a given host using native OAuth device flow in the background, extracting verification URL and code.
 */
export async function loginPixiHostOAuth(
    host: string,
    onPromptReceived: (details: OAuthPromptDetails) => void | Promise<void>,
    token?: CancellationToken,
): Promise<string> {
    const pixi = await getPixi();
    const args = ['auth', 'login', host, '--oauth', '--no-progress'];
    const { useShell, finalArgs } = resolveSpawnArgs(pixi, args);

    return new Promise<string>((resolve, reject) => {
        const proc = ch.spawn(pixi, finalArgs, {
            shell: useShell,
            windowsHide: true,
            cwd: workspace.workspaceFolders?.[0]?.uri.fsPath,
        });

        let debounceTimer: NodeJS.Timeout | undefined;

        const cancelDisposable = token?.onCancellationRequested(() => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = undefined;
            }
            proc.kill();
            reject(new CancellationError());
        });

        let stdout = '';
        let stderr = '';
        let promptHandled = false;
        let pendingUri: string | undefined;

        const firePrompt = (uri: string, code?: string) => {
            if (promptHandled) {
                return;
            }
            promptHandled = true;
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = undefined;
            }
            try {
                void onPromptReceived({ verificationUri: uri, userCode: code });
            } catch {
                // Ignore prompt callback error
            }
        };

        const checkOutputForPrompt = () => {
            if (promptHandled) {
                return;
            }
            const combined = `${stdout}\n${stderr}`;
            const directUrlMatch = combined.match(/https:\/\/[^\s]+/);
            if (!directUrlMatch) {
                return;
            }

            const rawUrl = directUrlMatch[0];
            const verificationUri = rawUrl.replace(/[.,;!?)"'>]+$/, '');
            pendingUri = verificationUri;

            const codeMatch =
                combined.match(/(?:enter code|and enter code):\s*([A-Za-z0-9_-]+)/i) ||
                verificationUri.match(/[?&]user_code=([A-Za-z0-9_-]+)/i);
            const userCode = codeMatch ? codeMatch[1] : undefined;

            if (userCode || combined.toLowerCase().includes('waiting for')) {
                firePrompt(verificationUri, userCode);
                return;
            }

            if (!debounceTimer) {
                debounceTimer = setTimeout(() => {
                    if (!promptHandled && pendingUri) {
                        firePrompt(pendingUri, undefined);
                    }
                }, 150);
            }
        };

        proc.stdout?.on('data', (data) => {
            const str = data.toString('utf-8');
            stdout += str;
            checkOutputForPrompt();
        });

        proc.stderr?.on('data', (data) => {
            const str = data.toString('utf-8');
            stderr += str;
            checkOutputForPrompt();
        });

        proc.on('error', (err) => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = undefined;
            }
            cancelDisposable?.dispose();
            reject(err);
        });

        proc.on('close', (exitCode) => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = undefined;
            }
            cancelDisposable?.dispose();
            if (exitCode !== 0) {
                const safeCommand = `pixi ${sanitizeArgsForLogging(args).join(' ')}`;
                traceError(`OAuth login failed for "${safeCommand}":\n${stderr}`);
                reject(new Error(stderr.trim() || `OAuth authentication failed with exit code ${exitCode}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Remove stored authentication for a given host or all hosts.
 */
export async function logoutPixiHost(host?: string, all?: boolean): Promise<string> {
    const args = ['auth', 'logout', '--no-progress'];
    if (all) {
        args.push('--all');
    } else if (host) {
        args.push(host);
    }
    return runPixi(args, { includeStderr: true });
}

/**
 * Fetch the stored authentication token for a host.
 */
export async function getPixiAuthToken(host: string): Promise<string> {
    const stdout = await runPixi(['auth', 'token', host, '--no-progress'], { includeStderr: true });
    return stdout.trim();
}

/**
 * Fetch authentication status output.
 */
export async function getPixiAuthStatus(): Promise<string> {
    const stdout = await runPixi(['auth', 'status', '--no-progress'], { includeStderr: true });
    return stdout.trim();
}
