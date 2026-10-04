import * as fs from 'fs';
import * as path from 'path';

import { runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { PixiPackage } from './types';

export { PixiPackage };

interface ManifestCandidate {
    filename: string;
    versionRegex: RegExp;
}

const TOML_VERSION_REGEX = /(?:^|\n)\s*version\s*=\s*["']([^"']+)["']/;

const MANIFEST_CANDIDATES: readonly ManifestCandidate[] = [
    {
        filename: 'pixi.toml',
        versionRegex: TOML_VERSION_REGEX,
    },
    {
        filename: 'pyproject.toml',
        versionRegex: TOML_VERSION_REGEX,
    },
    {
        filename: 'setup.cfg',
        versionRegex: /(?:^|\n)\s*version\s*=\s*([^\s\r\n]+)/,
    },
    {
        filename: 'setup.py',
        versionRegex: /version\s*=\s*["']([^"']+)["']/,
    },
];

/**
 * Enriches local/editable subpackages with version and manifest path from their local directories.
 */
export async function enrichLocalPackages(packages: PixiPackage[], projectPath: string): Promise<PixiPackage[]> {
    await Promise.all(
        packages.map(async (pkg) => {
            try {
                let candidateDir: string | undefined;

                if (pkg.source && (pkg.source.startsWith('.') || path.isAbsolute(pkg.source))) {
                    candidateDir = path.resolve(projectPath, pkg.source);
                } else if (pkg.requested_spec) {
                    const pathMatch = pkg.requested_spec.match(/path\s*=\s*["']([^"']+)["']/);
                    if (pathMatch && pathMatch[1]) {
                        candidateDir = path.resolve(projectPath, pathMatch[1]);
                    }
                }

                if (!candidateDir) {
                    return;
                }

                const stats = await fs.promises.stat(candidateDir).catch(() => null);
                if (!stats || !stats.isDirectory()) {
                    return;
                }

                pkg.is_local = true;
                const editableMatch = pkg.requested_spec?.match(/editable\s*=\s*(true|false)/i);
                pkg.is_editable = editableMatch
                    ? editableMatch[1].toLowerCase() === 'true'
                    : Boolean(pkg.source && (pkg.source.startsWith('.') || pkg.source.includes('packages')));
                pkg.local_path = path.relative(projectPath, candidateDir);

                for (const candidate of MANIFEST_CANDIDATES) {
                    const candidateFile = path.join(candidateDir, candidate.filename);
                    const content = await fs.promises.readFile(candidateFile, 'utf8').catch(() => null);
                    if (content !== null) {
                        pkg.local_manifest_path = candidateFile;
                        if (!pkg.version) {
                            const m = content.match(candidate.versionRegex);
                            if (m && m[1]) {
                                pkg.version = m[1];
                            }
                        }
                        break;
                    }
                }
            } catch {
                // ignore errors for individual packages
            }
        }),
    );
    return packages;
}

/**
 * Executes 'pixi list' and returns all packages for the specified environment.
 */
export async function listPixiPackages(envName: string, projectPath: string): Promise<PixiPackage[]> {
    const baseArgs = ['list', '--no-install', '--json', '--environment', envName];
    let stdout: string;
    try {
        stdout = await runPixi(['list', '--no-install', '--frozen', '--json', '--environment', envName], {
            cwd: projectPath,
        });
    } catch {
        try {
            stdout = await runPixi(baseArgs, { cwd: projectPath });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('no platform supported') || msg.includes('unsupported-platform')) {
                traceVerbose(
                    `Skipping package listing for platform-incompatible environment '${envName}' in ${projectPath}`,
                );
            } else {
                traceError(`Failed to list packages for environment '${envName}' in ${projectPath}:`, error);
            }
            return [];
        }
    }

    const packages = safeJsonParse<PixiPackage[]>(stdout, []);

    if (packages.length > 0) {
        await enrichLocalPackages(packages, projectPath);
    }

    return packages;
}

/**
 * Deterministically sorts Pixi packages: explicit dependencies first, then alphabetically by name.
 */
export function sortPixiPackages(packages: PixiPackage[]): PixiPackage[] {
    return [...packages].sort((a, b) => {
        if (Boolean(a.is_explicit) !== Boolean(b.is_explicit)) {
            return a.is_explicit ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}
