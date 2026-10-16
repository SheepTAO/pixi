import * as fs from 'fs';
import * as path from 'path';

import { runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError, traceVerbose } from '../common/logging';
import { SUPPORTED_MANIFEST_NAMES } from './projectDiscovery';
import { PixiPackage } from './types';

interface ManifestCandidate {
    filename: string;
    versionRegex: RegExp;
}

const TOML_VERSION_REGEX = /(?:^|\n)\s*version\s*=\s*["']([^"']+)["']/;

const MANIFEST_CANDIDATES: readonly ManifestCandidate[] = [
    ...SUPPORTED_MANIFEST_NAMES.map((filename) => ({
        filename,
        versionRegex: TOML_VERSION_REGEX,
    })),
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
    const candidates = packages.filter(
        (pkg) =>
            (pkg.source && (pkg.source.startsWith('.') || path.isAbsolute(pkg.source))) ||
            (pkg.requested_spec && /path\s*=/.test(pkg.requested_spec)),
    );
    if (candidates.length === 0) {
        return packages;
    }

    await Promise.all(
        candidates.map(async (pkg) => {
            try {
                let candidateDir: string | undefined;

                if (pkg.source && (pkg.source.startsWith('.') || path.isAbsolute(pkg.source))) {
                    candidateDir = path.resolve(projectPath, pkg.source);
                } else if (pkg.requested_spec) {
                    const pathMatch = pkg.requested_spec.match(/path\s*=\s*["']([^"']+)["']/);
                    if (pathMatch?.[1]) {
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
                            if (m?.[1]) {
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
    let stdout: string;
    try {
        stdout = await runPixi(['list', '--no-install', '--json', '--environment', envName, '--frozen'], {
            cwd: projectPath,
        });
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

/**
 * Extracts the bare package name from a version specification string (e.g., "numpy>=1.20" -> "numpy").
 */
export function extractPackageNameFromSpec(spec: string): string {
    const cleaned = spec.trim();
    const name = cleaned.split(/[<>=~!\s\[]/)[0].trim();
    return name || cleaned;
}

/**
 * Normalizes package names for resilient cross-ecosystem lookup (PEP 503).
 */
export function normalizePkgName(name: string): string {
    return extractPackageNameFromSpec(name)
        .toLowerCase()
        .replace(/[-_.]+/g, '-');
}

export interface SplitPackageSpecResult {
    name: string;
    constraint: string;
}

/**
 * Splits a raw package specification into its bare package name and version constraint.
 * e.g., "numpy>=1.20" -> { name: "numpy", constraint: ">=1.20" }
 */
export function splitPackageSpec(spec: string): SplitPackageSpecResult {
    const trimmed = spec.trim();
    const name = extractPackageNameFromSpec(trimmed);
    const constraint = trimmed.slice(name.length).trim();
    return { name, constraint };
}

/**
 * Returns a standardized badge string for a package ecosystem ('[PyPI]' or '[Conda]').
 */
export function getPackageKindBadge(kind?: string): string {
    return kind === 'pypi' ? '[PyPI]' : '[Conda]';
}

/**
 * Constructs a package overview URL on prefix.dev for a given Conda channel and package name.
 */
export function getPrefixDevPackageUrl(channel: string, packageName: string): string {
    return `https://prefix.dev/channels/${encodeURIComponent(channel)}/packages/${encodeURIComponent(packageName)}`;
}

/**
 * Constructs a package overview URL on PyPI for a given package name.
 */
export function getPypiPackageUrl(packageName: string): string {
    return `https://pypi.org/project/${encodeURIComponent(packageName)}/`;
}
