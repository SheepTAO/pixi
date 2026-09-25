import * as fs from 'fs';
import * as path from 'path';

import { findExecutable } from '../common/execUtils';

export interface PythonToolchainInfo {
    executable: string;
    version?: string;
}

export interface CppToolchainInfo {
    compiler?: string;
    compilerType?: 'gcc' | 'clang' | 'msvc';
    cmake?: string;
    ninja?: string;
    includeDir?: string;
}

export interface RToolchainInfo {
    executable: string;
    rscript?: string;
    version?: string;
}

export interface RustToolchainInfo {
    rustc?: string;
    cargo?: string;
    version?: string;
}

export interface EnvironmentToolchains {
    python?: PythonToolchainInfo;
    cpp?: CppToolchainInfo;
    r?: RToolchainInfo;
    rust?: RustToolchainInfo;
}

/**
 * Reads all files from conda-meta/ directory once.
 */
async function readCondaMetaFiles(envPath: string): Promise<string[]> {
    try {
        const metaDir = path.join(envPath, 'conda-meta');
        const stats = await fs.promises.stat(metaDir).catch(() => null);
        if (stats?.isDirectory()) {
            return await fs.promises.readdir(metaDir);
        }
    } catch {
        // ignore
    }
    return [];
}

/**
 * Extracts a package version from a list of conda-meta filenames.
 * e.g. python-3.11.8-h123_0.json -> "3.11.8"
 */
function findPackageVersionFromFiles(files: string[], pkgPrefix: string): string | undefined {
    const regex = new RegExp(`^${pkgPrefix}-(\\d[^-]*)-.*\\.json$`);
    for (const file of files) {
        const match = file.match(regex);
        if (match) {
            return match[1];
        }
    }
    return undefined;
}

/**
 * Reads a package version from conda-meta/ directory.
 */
async function findPackageVersionFromMeta(
    envPath: string,
    pkgPrefix: string,
    metaFiles?: string[],
): Promise<string | undefined> {
    const files = metaFiles ?? (await readCondaMetaFiles(envPath));
    return findPackageVersionFromFiles(files, pkgPrefix);
}

/**
 * Scans an environment prefix for Python toolchains.
 */
export async function scanPythonToolchain(
    envPath: string,
    metaFiles?: string[],
): Promise<PythonToolchainInfo | undefined> {
    const executable = await findExecutable(envPath, {
        posix: ['bin/python', 'bin/python3', 'python', 'python3'],
        win32: [
            'Scripts/python.exe',
            'Scripts/python3.exe',
            'bin/python.exe',
            'bin/python3.exe',
            'python.exe',
            'python3.exe',
        ],
    });

    if (!executable) {
        return undefined;
    }

    const version = await findPackageVersionFromMeta(envPath, 'python', metaFiles);
    return {
        executable,
        version,
    };
}

/**
 * Scans an environment prefix for C/C++ toolchains (compilers, cmake, ninja, headers).
 */
export async function scanCppToolchain(envPath: string): Promise<CppToolchainInfo | undefined> {
    // 1. Detect compiler
    const compiler = await findExecutable(envPath, {
        posix: ['bin/g++', 'bin/gcc', 'bin/clang++', 'bin/clang'],
        win32: [
            'Library/bin/clang++.exe',
            'Library/bin/clang.exe',
            'Library/bin/g++.exe',
            'Library/bin/gcc.exe',
            'bin/cl.exe',
            'bin/g++.exe',
            'bin/gcc.exe',
        ],
    });

    // 2. Detect cmake
    const cmake = await findExecutable(envPath, {
        posix: ['bin/cmake'],
        win32: ['Scripts/cmake.exe', 'Library/bin/cmake.exe', 'bin/cmake.exe'],
    });

    // 3. Detect ninja
    const ninja = await findExecutable(envPath, {
        posix: ['bin/ninja'],
        win32: ['Scripts/ninja.exe', 'Library/bin/ninja.exe', 'bin/ninja.exe'],
    });

    // 4. Detect include directory
    let includeDir: string | undefined;
    const posixInclude = path.join(envPath, 'include');
    const winInclude = path.join(envPath, 'Library', 'include');
    if (fs.existsSync(posixInclude)) {
        includeDir = posixInclude;
    } else if (fs.existsSync(winInclude)) {
        includeDir = winInclude;
    }

    if (!compiler && !cmake && !ninja && !includeDir) {
        return undefined;
    }

    let compilerType: 'gcc' | 'clang' | 'msvc' | undefined;
    if (compiler) {
        const base = path.basename(compiler).toLowerCase();
        if (base.includes('clang')) {
            compilerType = 'clang';
        } else if (base.includes('g++') || base.includes('gcc')) {
            compilerType = 'gcc';
        } else if (base.includes('cl.exe')) {
            compilerType = 'msvc';
        }
    }

    return {
        compiler: compiler ?? undefined,
        compilerType,
        cmake: cmake ?? undefined,
        ninja: ninja ?? undefined,
        includeDir,
    };
}

/**
 * Scans an environment prefix for R toolchains (R, Rscript).
 */
export async function scanRToolchain(envPath: string, metaFiles?: string[]): Promise<RToolchainInfo | undefined> {
    const executable = await findExecutable(envPath, {
        posix: ['bin/R', 'bin/Rscript'],
        win32: ['bin/R.exe', 'bin/x64/R.exe', 'bin/Rscript.exe'],
    });

    if (!executable) {
        return undefined;
    }

    const rscript = await findExecutable(envPath, {
        posix: ['bin/Rscript'],
        win32: ['bin/Rscript.exe', 'bin/x64/Rscript.exe'],
    });

    const version = await findPackageVersionFromMeta(envPath, 'r-base', metaFiles);

    return {
        executable,
        rscript: rscript ?? undefined,
        version,
    };
}

/**
 * Scans an environment prefix for Rust toolchains (rustc, cargo).
 */
export async function scanRustToolchain(envPath: string, metaFiles?: string[]): Promise<RustToolchainInfo | undefined> {
    const rustc = await findExecutable(envPath, {
        posix: ['bin/rustc'],
        win32: ['bin/rustc.exe', 'Library/bin/rustc.exe'],
    });

    const cargo = await findExecutable(envPath, {
        posix: ['bin/cargo'],
        win32: ['bin/cargo.exe', 'Library/bin/cargo.exe'],
    });

    if (!rustc && !cargo) {
        return undefined;
    }

    const version = await findPackageVersionFromMeta(envPath, 'rust', metaFiles);

    return {
        rustc: rustc ?? undefined,
        cargo: cargo ?? undefined,
        version,
    };
}

/**
 * Scans an installed Pixi environment prefix for all supported language toolchains.
 */
export async function scanEnvironmentToolchains(envPath: string): Promise<EnvironmentToolchains> {
    const metaFiles = await readCondaMetaFiles(envPath);
    const [python, cpp, r, rust] = await Promise.all([
        scanPythonToolchain(envPath, metaFiles),
        scanCppToolchain(envPath),
        scanRToolchain(envPath, metaFiles),
        scanRustToolchain(envPath, metaFiles),
    ]);

    const result: EnvironmentToolchains = {};
    if (python) {
        result.python = python;
    }
    if (cpp) {
        result.cpp = cpp;
    }
    if (r) {
        result.r = r;
    }
    if (rust) {
        result.rust = rust;
    }

    return result;
}
