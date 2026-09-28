import * as fs from 'fs';
import * as path from 'path';

import { runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';
import { traceError } from '../common/logging';
import { PixiPackage } from './types';

export { PixiPackage };

/**
 * Enriches local/editable subpackages with version and manifest path from their local directories.
 */
export async function enrichLocalPackages(packages: PixiPackage[], projectPath: string): Promise<PixiPackage[]> {
    await Promise.all(
        packages.map(async (pkg) => {
            try {
                let candidateDir: string | undefined;

                if (pkg.source && (pkg.source.startsWith('.') || path.isAbsolute(pkg.source))) {
                    candidateDir = path.isAbsolute(pkg.source) ? pkg.source : path.resolve(projectPath, pkg.source);
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

                // Look for manifest file: pixi.toml, pyproject.toml, setup.cfg, setup.py
                const pixiFile = path.join(candidateDir, 'pixi.toml');
                const pyprojectFile = path.join(candidateDir, 'pyproject.toml');
                const setupCfgFile = path.join(candidateDir, 'setup.cfg');
                const setupPyFile = path.join(candidateDir, 'setup.py');

                if (fs.existsSync(pixiFile)) {
                    pkg.local_manifest_path = pixiFile;
                    if (!pkg.version) {
                        const content = await fs.promises.readFile(pixiFile, 'utf8').catch(() => '');
                        const m = content.match(/(?:^|\n)\s*version\s*=\s*["']([^"']+)["']/);
                        if (m && m[1]) {
                            pkg.version = m[1];
                        }
                    }
                } else if (fs.existsSync(pyprojectFile)) {
                    pkg.local_manifest_path = pyprojectFile;
                    if (!pkg.version) {
                        const content = await fs.promises.readFile(pyprojectFile, 'utf8').catch(() => '');
                        const m = content.match(/(?:^|\n)\s*version\s*=\s*["']([^"']+)["']/);
                        if (m && m[1]) {
                            pkg.version = m[1];
                        }
                    }
                } else if (fs.existsSync(setupCfgFile)) {
                    pkg.local_manifest_path = setupCfgFile;
                    if (!pkg.version) {
                        const content = await fs.promises.readFile(setupCfgFile, 'utf8').catch(() => '');
                        const m = content.match(/(?:^|\n)\s*version\s*=\s*([^\s\r\n]+)/);
                        if (m && m[1]) {
                            pkg.version = m[1];
                        }
                    }
                } else if (fs.existsSync(setupPyFile)) {
                    pkg.local_manifest_path = setupPyFile;
                    if (!pkg.version) {
                        const content = await fs.promises.readFile(setupPyFile, 'utf8').catch(() => '');
                        const m = content.match(/version\s*=\s*["']([^"']+)["']/);
                        if (m && m[1]) {
                            pkg.version = m[1];
                        }
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
    let packages: PixiPackage[] = [];
    try {
        const stdout = await runPixi(['list', '--no-install', '--frozen', '--json', '--environment', envName], {
            cwd: projectPath,
        });
        packages = safeJsonParse<PixiPackage[]>(stdout, []);
    } catch {
        try {
            const stdout = await runPixi(['list', '--no-install', '--json', '--environment', envName], {
                cwd: projectPath,
            });
            packages = safeJsonParse<PixiPackage[]>(stdout, []);
        } catch (error) {
            traceError(`Failed to list packages for environment '${envName}' in ${projectPath}:`, error);
            return [];
        }
    }

    if (packages.length > 0) {
        await enrichLocalPackages(packages, projectPath);
    }

    return packages;
}
