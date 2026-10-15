import * as fs from 'fs';
import { Range, Uri, workspace, WorkspaceEdit } from 'vscode';

import { unquoteString } from '../common/execUtils';
import { findManifestPath, isPyproject } from './projectDiscovery';

export interface SystemRequirementsRecord {
    cuda?: string;
    libc?: string;
    linux?: string;
    macos?: string;
    archspec?: string;
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
}

export const SYSTEM_REQUIREMENT_DESCRIPTORS: SystemRequirementDescriptor[] = [
    {
        id: 'cuda',
        label: 'CUDA',
        description: 'Minimum CUDA version required by the project (e.g. 12.6, 12.0)',
        icon: 'chip',
        presets: ['12.8', '12.6', '12.4', '12.2', '12.0', '11.8'],
        placeholder: 'e.g. 12.6 or 12.0',
    },
    {
        id: 'libc',
        label: 'C Library (glibc)',
        description: 'Minimum C library version required (e.g. 2.31, 2.28)',
        icon: 'library',
        presets: ['2.39', '2.35', '2.31', '2.28', '2.17'],
        placeholder: 'e.g. 2.31',
    },
    {
        id: 'linux',
        label: 'Linux Kernel',
        description: 'Minimum Linux kernel version required (e.g. 5.10, 6.1)',
        icon: 'server-process',
        presets: ['6.8', '6.1', '5.15', '5.10', '4.18'],
        placeholder: 'e.g. 5.10',
    },
    {
        id: 'macos',
        label: 'macOS Version',
        description: 'Minimum macOS version required (e.g. 14.0, 11.0)',
        icon: 'terminal',
        presets: ['14.0', '13.0', '12.0', '11.0', '10.15'],
        placeholder: 'e.g. 11.0',
    },
    {
        id: 'archspec',
        label: 'CPU Architecture',
        description: 'Microarchitecture specification (e.g. x86_64_v3, arm64)',
        icon: 'circuit-board',
        presets: ['x86_64_v4', 'x86_64_v3', 'x86_64_v2', 'arm64', 'aarch64'],
        placeholder: 'e.g. x86_64_v3',
    },
    {
        id: 'unix',
        label: 'UNIX Support',
        description: 'Declare whether the project requires UNIX operating system',
        icon: 'check',
        presets: ['true', 'false'],
        placeholder: 'true or false',
    },
];

/**
 * Parses the [system-requirements] table from manifest content.
 */
export function parseManifestSystemRequirements(text: string): SystemRequirementsRecord | undefined {
    const lines = text.split(/\r?\n/);
    let inSection = false;
    const reqs: SystemRequirementsRecord = {};

    for (const rawLine of lines) {
        const line = rawLine.replace(/#.*$/, '').trim();
        const secMatch = line.match(/^\[+([^\]]+)\]+/);
        if (secMatch) {
            const sec = secMatch[1].trim();
            inSection = /^(?:tool\.pixi\.)?(?:workspace\.)?system-requirements$/i.test(sec);
            continue;
        }
        if (!inSection || !line) {
            continue;
        }

        const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
        if (kvMatch) {
            const key = kvMatch[1].trim();
            reqs[key] = unquoteString(kvMatch[2]);
        }
    }

    return Object.keys(reqs).length > 0 ? reqs : undefined;
}

/**
 * Reads the project system requirements from its manifest file.
 */
export function getProjectSystemRequirements(projectPath: string): SystemRequirementsRecord | undefined {
    const manifestFile = findManifestPath(projectPath);
    if (!manifestFile) {
        return undefined;
    }
    try {
        const content = fs.readFileSync(manifestFile, 'utf8');
        return parseManifestSystemRequirements(content);
    } catch {
        return undefined;
    }
}

function formatDisplayValue(val: string): string {
    if (val.startsWith('{') && val.endsWith('}')) {
        const verMatch = val.match(/version\s*=\s*["']([^"']+)["']/i);
        const familyMatch = val.match(/family\s*=\s*["']([^"']+)["']/i);
        if (verMatch) {
            return familyMatch ? `${familyMatch[1]} ${verMatch[1]}` : verMatch[1];
        }
        const driverMatch = val.match(/driver\s*=\s*["']([^"']+)["']/i);
        if (driverMatch) {
            return driverMatch[1];
        }
    }
    return val;
}

function formatTomlValue(key: string, val: string): string {
    if (key === 'unix' && (val === 'true' || val === 'false')) {
        return val;
    }
    if (val.startsWith('{') && val.endsWith('}')) {
        return val;
    }
    return `"${unquoteString(val)}"`;
}

/**
 * Formats a short summary of system requirements for tree item descriptions (e.g. "cuda: 12.6, linux: 5.10").
 */
export function formatSystemRequirementsSummary(reqs: SystemRequirementsRecord): string {
    const pairs = Object.entries(reqs).map(([k, v]) => `${k}: ${v ? formatDisplayValue(v) : ''}`);
    return pairs.length > 0 ? pairs.join(', ') : '';
}

/**
 * Pure function that updates the [system-requirements] table in a manifest string.
 */
export function updateManifestSystemRequirementsContent(
    content: string,
    updates: Record<string, string | null>,
    isPyprojectDoc: boolean,
): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const targetHeader = isPyprojectDoc ? 'tool.pixi.system-requirements' : 'system-requirements';

    let headerIdx = -1;
    let nextHeaderIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/#.*$/, '').trim();
        const secMatch = line.match(/^\[+([^\]]+)\]+/);
        if (secMatch) {
            const sec = secMatch[1].trim();
            if (/^(?:tool\.pixi\.)?(?:workspace\.)?system-requirements$/i.test(sec)) {
                headerIdx = i;
            } else if (headerIdx !== -1 && nextHeaderIdx === -1) {
                nextHeaderIdx = i;
                break;
            }
        }
    }

    if (headerIdx === -1) {
        // Section does not exist. Add it if we have non-null updates.
        const toAdd = Object.entries(updates).filter(
            ([_, v]) => v !== null && v !== undefined && v !== '',
        );
        if (toAdd.length === 0) {
            return content;
        }

        const newBlock = [
            '',
            `[${targetHeader}]`,
            ...toAdd.map(([k, v]) => `${k} = ${formatTomlValue(k, v!)}`),
        ];
        return content.trimEnd() + eol + newBlock.join(eol) + eol;
    }

    const endIdx = nextHeaderIdx !== -1 ? nextHeaderIdx : lines.length;
    const sectionLines = lines.slice(headerIdx + 1, endIdx);

    const keyLineMap = new Map<string, number>();
    const rebuildKeyMap = (): void => {
        keyLineMap.clear();
        for (let j = 0; j < sectionLines.length; j++) {
            const raw = sectionLines[j];
            const stripped = raw.replace(/#.*$/, '').trim();
            const kvMatch = stripped.match(/^([a-zA-Z0-9_-]+)\s*=/);
            if (kvMatch) {
                keyLineMap.set(kvMatch[1].trim(), j);
            }
        }
    };
    rebuildKeyMap();

    for (const [key, val] of Object.entries(updates)) {
        if (keyLineMap.has(key)) {
            const lineOffset = keyLineMap.get(key)!;
            if (val === null || val === undefined || val === '') {
                sectionLines.splice(lineOffset, 1);
                rebuildKeyMap();
            } else {
                const raw = sectionLines[lineOffset];
                const commentMatch = raw.match(/(#.*)$/);
                const inlineComment = commentMatch ? ` ${commentMatch[1]}` : '';
                const formattedVal = formatTomlValue(key, val);
                sectionLines[lineOffset] = `${key} = ${formattedVal}${inlineComment}`;
            }
        } else if (val !== null && val !== undefined && val !== '') {
            const formattedVal = formatTomlValue(key, val);
            sectionLines.unshift(`${key} = ${formattedVal}`);
            rebuildKeyMap();
        }
    }

    const remainingKeys = sectionLines.filter((l) => l.replace(/#.*$/, '').trim().includes('='));
    if (remainingKeys.length === 0) {
        // Section is empty, remove header and section
        lines.splice(headerIdx, endIdx - headerIdx);
        while (headerIdx < lines.length && lines[headerIdx].trim() === '') {
            lines.splice(headerIdx, 1);
        }
    } else {
        lines.splice(headerIdx + 1, endIdx - (headerIdx + 1), ...sectionLines);
    }

    return lines.join(eol);
}

/**
 * Updates project system requirements in the manifest file.
 */
export async function updateProjectSystemRequirements(
    projectPath: string,
    updates: Record<string, string | null>,
): Promise<boolean> {
    const manifestPath = findManifestPath(projectPath);
    if (!manifestPath) {
        return false;
    }

    const uri = Uri.file(manifestPath);
    const doc = await workspace.openTextDocument(uri);
    const text = doc.getText();
    const newContent = updateManifestSystemRequirementsContent(text, updates, isPyproject(manifestPath));

    if (newContent === text) {
        return true;
    }

    const edit = new WorkspaceEdit();
    const fullRange = new Range(doc.positionAt(0), doc.positionAt(text.length));
    edit.replace(doc.uri, fullRange, newContent);

    const applied = await workspace.applyEdit(edit);
    if (applied) {
        await doc.save();
    }
    return applied;
}

