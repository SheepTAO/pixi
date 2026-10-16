import { runPixi } from '../cli/pixiCli';
import { safeJsonParse } from '../common/execUtils';

export interface SystemRequirementsRecord {
    cuda?: string;
    libc?: string;
    linux?: string;
    macos?: string;
    archspec?: string;
    windows?: string;
    unix?: string;
    [key: string]: string | undefined;
}

export interface SystemRequirementDescriptor {
    id: string;
    label: string;
    description: string;
    icon: string;
    presets: string[];
    placeholder: string;
    cliFlag?: string;
    virtualPackageName?: string;
}

export const SYSTEM_REQUIREMENT_DESCRIPTORS: SystemRequirementDescriptor[] = [
    {
        id: 'cuda',
        label: 'CUDA',
        description: 'Minimum CUDA version required by the project (e.g. 12.6, 12.0)',
        icon: 'chip',
        presets: ['12.8', '12.6', '12.4', '12.2', '12.0', '11.8'],
        placeholder: 'e.g. 12.6 or 12.0',
        cliFlag: '--cuda',
        virtualPackageName: '__cuda',
    },
    {
        id: 'libc',
        label: 'C Library (glibc)',
        description: 'Minimum C library version required (e.g. 2.31, 2.28)',
        icon: 'library',
        presets: ['2.39', '2.35', '2.31', '2.28', '2.17'],
        placeholder: 'e.g. 2.31',
        cliFlag: '--glibc',
        virtualPackageName: '__glibc',
    },
    {
        id: 'linux',
        label: 'Linux Kernel',
        description: 'Minimum Linux kernel version required (e.g. 5.10, 6.1)',
        icon: 'server-process',
        presets: ['6.8', '6.1', '5.15', '5.10', '4.18'],
        placeholder: 'e.g. 5.10',
        cliFlag: '--linux',
        virtualPackageName: '__linux',
    },
    {
        id: 'macos',
        label: 'macOS Version',
        description: 'Minimum macOS version required (e.g. 14.0, 11.0)',
        icon: 'terminal',
        presets: ['14.0', '13.0', '12.0', '11.0', '10.15'],
        placeholder: 'e.g. 11.0',
        cliFlag: '--macos',
        virtualPackageName: '__osx',
    },
    {
        id: 'windows',
        label: 'Windows Version',
        description: 'Minimum Windows version required (e.g. 11, 10)',
        icon: 'terminal',
        presets: ['11', '10'],
        placeholder: 'e.g. 10',
        cliFlag: '--windows',
        virtualPackageName: '__win',
    },
    {
        id: 'archspec',
        label: 'CPU Architecture',
        description: 'Microarchitecture specification (e.g. x86_64_v3, arm64)',
        icon: 'circuit-board',
        presets: ['x86_64_v4', 'x86_64_v3', 'x86_64_v2', 'arm64', 'aarch64'],
        placeholder: 'e.g. x86_64_v3',
        cliFlag: '--archspec',
        virtualPackageName: '__archspec',
    },
    {
        id: 'unix',
        label: 'UNIX Support',
        description: 'Declare whether the project requires UNIX operating system',
        icon: 'check',
        presets: ['true', 'false'],
        placeholder: 'true or false',
        virtualPackageName: '__unix',
    },
];

interface RawPlatformListJson {
    platforms?: Array<{
        name: string;
        subdir?: string;
        virtual_packages?: string[];
        features?: string[];
        environments?: string[];
        is_autodetected?: boolean;
    }>;
}

export interface WorkspacePlatformEntry {
    name: string;
    subdir?: string;
    virtualPackages: string[];
    features: string[];
    environments: string[];
}

import type { PixiProjectManager } from './projectManager';

/**
 * Retrieves the workspace platforms and declared virtual packages natively via in-memory manager or `pixi workspace platform list --json`.
 */
export async function getWorkspacePlatforms(
    projectPath: string,
    manager?: PixiProjectManager,
): Promise<WorkspacePlatformEntry[]> {
    if (manager) {
        const cached = manager.getPlatformsForProject(projectPath);
        if (cached.length > 0) {
            return cached;
        }
    }
    try {
        const jsonOut = await runPixi(['workspace', 'platform', 'list', '--json'], { cwd: projectPath });
        const parsed = safeJsonParse<RawPlatformListJson>(jsonOut);
        if (parsed?.platforms && Array.isArray(parsed.platforms)) {
            return parsed.platforms
                .filter((p) => !p.is_autodetected && Boolean(p.name))
                .map((p) => ({
                    name: p.name,
                    subdir: p.subdir,
                    virtualPackages: p.virtual_packages || [],
                    features: p.features || [],
                    environments: p.environments || [],
                }));
        }
    } catch {
        // Fall back to empty array if CLI execution fails
    }
    return [];
}

/**
 * Reads project platform virtual packages natively from Pixi workspace platforms.
 */
export async function getProjectSystemRequirements(
    projectPath: string,
    manager?: PixiProjectManager,
): Promise<SystemRequirementsRecord | undefined> {
    const platforms = await getWorkspacePlatforms(projectPath, manager);
    const reqs: SystemRequirementsRecord = {};

    for (const p of platforms) {
        for (const vp of p.virtualPackages) {
            const [rawKey, ...valParts] = vp.split('=');
            const key = rawKey.replace(/^__/, '').toLowerCase();
            const val = valParts.length > 0 ? valParts.join('=') : 'true';
            if (key === 'glibc') {
                reqs['libc'] = val;
            } else if (key === 'osx') {
                reqs['macos'] = val;
            } else if (key === 'win') {
                reqs['windows'] = val;
            } else {
                reqs[key] = val;
            }
        }
    }

    return Object.keys(reqs).length > 0 ? reqs : undefined;
}

/**
 * Formats a short summary of system requirements for tree item descriptions (e.g. "cuda: 12.6, linux: 5.10").
 */
export function formatSystemRequirementsSummary(reqs: SystemRequirementsRecord): string {
    const pairs = Object.entries(reqs).map(([k, v]) => `${k}: ${v}`);
    return pairs.length > 0 ? pairs.join(', ') : '';
}
