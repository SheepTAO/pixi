import * as fs from 'fs';
import * as path from 'path';
import {
    CancellationToken,
    commands,
    Definition,
    DefinitionProvider,
    Disposable,
    DocumentFilter,
    Event,
    EventEmitter,
    Hover,
    HoverProvider,
    InlayHint,
    InlayHintKind,
    InlayHintLabelPart,
    InlayHintsProvider,
    languages,
    Location,
    MarkdownString,
    Position,
    Range,
    Selection,
    TextDocument,
    TextEditorRevealType,
    Uri,
    window,
    workspace,
} from 'vscode';

import { PixiProjectManager } from '../core/projectManager';
import { PixiPackage } from '../core/types';

export interface ParsedDependency {
    name: string;
    section: string;
    line: number;
    nameRange: Range;
    valueRange: Range;
    insertPosition: Position;
    requestedSpec?: string;
}

interface LockfileCache {
    mtimeMs: number;
    lines: string[];
}

const lockfileCache = new Map<string, LockfileCache>();

/**
 * Reads lines of pixi.lock with mtime-based in-memory caching.
 */
async function getLockfileLines(lockPath: string): Promise<string[] | undefined> {
    try {
        const stats = await fs.promises.stat(lockPath);
        const cached = lockfileCache.get(lockPath);
        if (cached && cached.mtimeMs === stats.mtimeMs) {
            return cached.lines;
        }
        const content = await fs.promises.readFile(lockPath, 'utf8');
        const lines = content.split(/\r?\n/);
        lockfileCache.set(lockPath, { mtimeMs: stats.mtimeMs, lines });
        return lines;
    } catch {
        lockfileCache.delete(lockPath);
        return undefined;
    }
}

/**
 * Finds the line index of a package in pixi.lock.
 * Prioritizes the detailed package record under top-level 'packages:',
 * then falls back to environment package list.
 */
export async function findPackageLineInLockfile(lockPath: string, pkgName: string): Promise<number> {
    const lines = await getLockfileLines(lockPath);
    if (!lines) {
        return -1;
    }

    const escaped = pkgName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const altName = pkgName.includes('_') ? pkgName.replace(/_/g, '-') : pkgName.replace(/-/g, '_');
    const altEscaped = altName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

    const regCondaOrPypi = new RegExp(
        `^\\s*-\\s*(?:conda|pypi):\\s*.*[/\\\\](?:${escaped}|${altEscaped})(?:-[0-9]|[/\\\\]?\\s*$)`,
        'i',
    );
    const regName = new RegExp(`^\\s*name:\\s*["']?(?:${escaped}|${altEscaped})["']?\\s*$`, 'i');

    const packagesIndex = lines.findIndex((l) => /^packages:\s*$/.test(l));
    if (packagesIndex !== -1) {
        for (let i = packagesIndex; i < lines.length; i++) {
            if (regCondaOrPypi.test(lines[i]) || regName.test(lines[i])) {
                return i;
            }
        }
    }

    for (let i = 0; i < lines.length; i++) {
        if (regCondaOrPypi.test(lines[i]) || regName.test(lines[i])) {
            return i;
        }
    }

    const broadReg = new RegExp(`[/\\\\](?:${escaped}|${altEscaped})(?:-[0-9]|[/\\\\]?\\s*$)`, 'i');
    for (let i = 0; i < lines.length; i++) {
        if (broadReg.test(lines[i])) {
            return i;
        }
    }

    return -1;
}

/**
 * Locates comment start in a TOML line, ignoring '#' characters inside quotes.
 */
function findCommentIndex(line: string): number {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && !inSingleQuote && (i === 0 || line[i - 1] !== '\\')) {
            inDoubleQuote = !inDoubleQuote;
        } else if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        } else if (char === '#' && !inSingleQuote && !inDoubleQuote) {
            return i;
        }
    }
    return -1;
}

/**
 * Normalizes package names for resilient cross-ecosystem lookup (PEP 503).
 */
function normalizePkgName(name: string): string {
    return name.toLowerCase().replace(/[-_.]+/g, '-');
}

const KV_DEP_SECTION_REGEX = /(?:^|\.)(?:pypi-|build-|host-)?dependencies$/i;
const KV_DEP_REGEX = /^\s*(?:(["'])([^"']+)\1|([a-zA-Z0-9_\-\.]+))\s*=\s*(.*)$/;
const ARRAY_DEP_REGEX = /^\s*(["'])([a-zA-Z0-9_\-\.]+)(?:[><=~^!].*|\[.*\])?\1,?\s*(?:#.*)?$/;

/**
 * Unified provider for manifest dependencies:
 * - InlayHintsProvider: shows locked versions inline (e.g. ': 1.26.4')
 * - HoverProvider: shows rich package metadata card with lock details
 * - DefinitionProvider: Ctrl+Click on package name navigates to pixi.lock
 */
export class PixiDependencyManifestProvider
    implements InlayHintsProvider, HoverProvider, DefinitionProvider, Disposable
{
    private readonly _onDidChangeInlayHints = new EventEmitter<void>();
    public readonly onDidChangeInlayHints: Event<void> = this._onDidChangeInlayHints.event;
    private readonly disposables: Disposable[] = [];

    constructor(private readonly projectManager: PixiProjectManager) {
        const selectors: DocumentFilter[] = [
            { scheme: 'file', pattern: '**/pixi.toml' },
            { scheme: 'file', pattern: '**/pyproject.toml' },
        ];

        this.disposables.push(
            languages.registerInlayHintsProvider(selectors, this),
            languages.registerHoverProvider(selectors, this),
            languages.registerDefinitionProvider(selectors, this),
        );

        this.disposables.push(
            this.projectManager.onDidProjectsChanged(() => this.refresh()),
            this.projectManager.onDidChangeEnvironments(() => this.refresh()),
            workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('pixi.dependencies.inlayHints')) {
                    this.refresh();
                }
            }),
        );

        this.disposables.push(
            commands.registerCommand(
                'pixi.openLockfile',
                async (options?: { projectPath?: string; packageName?: string } | Uri) => {
                    await this.openLockfileCommand(options);
                },
            ),
        );
    }

    public refresh(): void {
        this._onDidChangeInlayHints.fire();
    }

    public dispose(): void {
        this._onDidChangeInlayHints.dispose();
        lockfileCache.clear();
        Disposable.from(...this.disposables).dispose();
    }

    public isInlayHintsEnabled(document: TextDocument): boolean {
        const config = workspace.getConfiguration('pixi.dependencies', document.uri);
        return config.get<boolean>('inlayHints', true);
    }

    /**
     * Parses all dependency entries from pixi.toml or pyproject.toml.
     */
    public parseManifestDependencies(document: TextDocument): ParsedDependency[] {
        const lineCount = document.lineCount;
        let currentSection = '';
        let inArrayBlock = false;
        const deps: ParsedDependency[] = [];

        for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            const rawLine = document.lineAt(lineIndex).text;
            const commentIdx = findCommentIndex(rawLine);
            const codeLine = (commentIdx !== -1 ? rawLine.substring(0, commentIdx) : rawLine).trimEnd();
            const trimmed = codeLine.trim();

            if (!trimmed) {
                continue;
            }

            const secMatch = trimmed.match(/^\[+([^\]]+)\]+$/);
            if (secMatch) {
                currentSection = secMatch[1].trim().replace(/["']/g, '');
                inArrayBlock = false;
                continue;
            }

            // PEP 621 array dependencies in pyproject.toml
            if (currentSection === 'project' || currentSection.startsWith('project.optional-dependencies')) {
                if (/=\s*\[/.test(trimmed)) {
                    inArrayBlock = true;
                    continue;
                }
            }

            if (inArrayBlock) {
                if (trimmed.includes(']')) {
                    inArrayBlock = false;
                }
                const arrMatch = trimmed.match(ARRAY_DEP_REGEX);
                if (arrMatch) {
                    const pkgName = arrMatch[2];
                    const nameStart = rawLine.indexOf(pkgName);
                    const nameEnd = nameStart + pkgName.length;
                    const nameRange = new Range(lineIndex, nameStart, lineIndex, nameEnd);
                    const valEnd =
                        commentIdx !== -1
                            ? rawLine.substring(0, commentIdx).trimEnd().length
                            : rawLine.trimEnd().length;
                    const valueRange = new Range(lineIndex, nameEnd, lineIndex, valEnd);
                    const insertPosition = new Position(lineIndex, valEnd);
                    const requestedSpec = trimmed.replace(/^["']|["'],?$/g, '').trim();

                    deps.push({
                        name: pkgName,
                        section: currentSection,
                        line: lineIndex,
                        nameRange,
                        valueRange,
                        insertPosition,
                        requestedSpec,
                    });
                }
                continue;
            }

            // Standard Pixi table dependencies
            if (KV_DEP_SECTION_REGEX.test(currentSection)) {
                const kvMatch = codeLine.match(KV_DEP_REGEX);
                if (kvMatch) {
                    const pkgName = kvMatch[2] || kvMatch[3];
                    const nameStart = rawLine.indexOf(pkgName);
                    const nameEnd = nameStart + pkgName.length;
                    const nameRange = new Range(lineIndex, nameStart, lineIndex, nameEnd);

                    const eqIndex = rawLine.indexOf('=');
                    const afterEq = rawLine.substring(eqIndex + 1);
                    const valStart = eqIndex + 1 + (afterEq.length - afterEq.trimStart().length);
                    const valEnd =
                        commentIdx !== -1
                            ? rawLine.substring(0, commentIdx).trimEnd().length
                            : rawLine.trimEnd().length;
                    const valueRange = new Range(lineIndex, valStart, lineIndex, valEnd);
                    const insertPosition = new Position(lineIndex, valEnd);
                    const rawVal = rawLine.substring(valStart, valEnd).trim();
                    let requestedSpec = rawVal.replace(/^["']|["']$/g, '').trim();
                    if (rawVal.startsWith('{')) {
                        const versionMatch = rawVal.match(/version\s*=\s*["']([^"']+)["']/);
                        requestedSpec = versionMatch ? versionMatch[1] : rawVal;
                    }

                    deps.push({
                        name: pkgName,
                        section: currentSection,
                        line: lineIndex,
                        nameRange,
                        valueRange,
                        insertPosition,
                        requestedSpec,
                    });
                }
            }
        }

        return deps;
    }

    /**
     * Provide InlayHints showing locked version inline at the end of each dependency line.
     */
    public async provideInlayHints(
        document: TextDocument,
        range: Range,
        token: CancellationToken,
    ): Promise<InlayHint[]> {
        if (!this.isInlayHintsEnabled(document)) {
            return [];
        }

        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return [];
        }

        const deps = this.parseManifestDependencies(document);
        if (deps.length === 0 || token.isCancellationRequested) {
            return [];
        }

        // Filter dependencies that fall within the requested range
        const visibleDeps = deps.filter((d) => d.line >= range.start.line && d.line <= range.end.line);
        if (visibleDeps.length === 0) {
            return [];
        }

        const activeEnv = this.projectManager.getEnvironmentForUri(document.uri);
        const activeEnvName = activeEnv?.pixiEnvName || 'default';
        const activePackages = await this.projectManager.getPackagesForEnvironment(activeEnvName, projectPath);
        if (token.isCancellationRequested) {
            return [];
        }

        const activeMap = this.createPackageMap(activePackages);
        const hints: InlayHint[] = [];
        const missingDeps: ParsedDependency[] = [];

        for (const dep of visibleDeps) {
            const pkg = this.lookupPackage(activeMap, dep.name);
            if (pkg && pkg.version) {
                hints.push(this.createInlayHint(dep, pkg, activeEnvName, projectPath));
            } else {
                missingDeps.push(dep);
            }
        }

        // Fallback for dependencies not present in active environment (e.g. feature-specific dependencies)
        if (missingDeps.length > 0 && !token.isCancellationRequested) {
            const allEnvs = this.projectManager.getEnvironmentsForProject(projectPath);
            const otherEnvs = allEnvs.filter((e) => e.pixiEnvName !== activeEnvName && e.pixiStatus !== 'incompatible');

            if (otherEnvs.length > 0) {
                const otherResults = await Promise.all(
                    otherEnvs.map(async (e) => ({
                        envName: e.pixiEnvName,
                        map: this.createPackageMap(
                            await this.projectManager.getPackagesForEnvironment(e.pixiEnvName, projectPath),
                        ),
                    })),
                );

                if (token.isCancellationRequested) {
                    return hints;
                }

                for (const dep of missingDeps) {
                    for (const { envName, map } of otherResults) {
                        const pkg = this.lookupPackage(map, dep.name);
                        if (pkg && pkg.version) {
                            hints.push(this.createInlayHint(dep, pkg, envName, projectPath));
                            break;
                        }
                    }
                }
            }
        }

        return hints;
    }

    /**
     * Provide Hover card displaying locked version, build, channel, license, and multi-env differences.
     */
    public async provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
    ): Promise<Hover | undefined> {
        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return undefined;
        }

        const deps = this.parseManifestDependencies(document);
        if (deps.length === 0 || token.isCancellationRequested) {
            return undefined;
        }

        const matched = deps.find(
            (d) =>
                d.line === position.line &&
                ((position.character >= d.nameRange.start.character &&
                    position.character <= d.nameRange.end.character) ||
                    (position.character >= d.valueRange.start.character &&
                        position.character <= d.valueRange.end.character)),
        );

        if (!matched || token.isCancellationRequested) {
            return undefined;
        }

        const activeEnv = this.projectManager.getEnvironmentForUri(document.uri);
        const activeEnvName = activeEnv?.pixiEnvName || 'default';
        const activePackages = await this.projectManager.getPackagesForEnvironment(activeEnvName, projectPath);
        if (token.isCancellationRequested) {
            return undefined;
        }

        const activeMap = this.createPackageMap(activePackages);
        let targetPkg = this.lookupPackage(activeMap, matched.name);
        let foundEnvName = activeEnvName;

        // Collect cross-environment occurrences
        const allEnvs = this.projectManager.getEnvironmentsForProject(projectPath);
        const envVersions = new Map<string, PixiPackage>();

        if (targetPkg) {
            envVersions.set(activeEnvName, targetPkg);
        }

        const otherEnvs = allEnvs.filter((e) => e.pixiEnvName !== activeEnvName && e.pixiStatus !== 'incompatible');
        if (otherEnvs.length > 0) {
            const otherResults = await Promise.all(
                otherEnvs.map(async (e) => ({
                    envName: e.pixiEnvName,
                    packages: await this.projectManager.getPackagesForEnvironment(e.pixiEnvName, projectPath),
                })),
            );

            if (token.isCancellationRequested) {
                return undefined;
            }

            for (const { envName, packages } of otherResults) {
                const map = this.createPackageMap(packages);
                const pkg = this.lookupPackage(map, matched.name);
                if (pkg) {
                    envVersions.set(envName, pkg);
                    if (!targetPkg) {
                        targetPkg = pkg;
                        foundEnvName = envName;
                    }
                }
            }
        }

        const lockPath = path.join(projectPath, 'pixi.lock');
        const lockExists = fs.existsSync(lockPath);
        const md = new MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;

        if (!targetPkg) {
            md.appendMarkdown(`### $(package) **${matched.name}**\n\n`);
            if (matched.requestedSpec) {
                md.appendMarkdown(`- **Requested Spec**: \`${matched.requestedSpec}\`\n`);
            }
            md.appendMarkdown(`- **Section**: \`${matched.section}\`\n\n`);
            if (!lockExists) {
                md.appendMarkdown(`*No lockfile (\`pixi.lock\`) found for this project.*\n\n`);
            } else {
                md.appendMarkdown(`*Not resolved in \`pixi.lock\` yet.*\n\n`);
            }
            md.appendMarkdown(`[$(lock) Run Pixi Lock](command:pixi.lock "Update project lockfile")`);
        } else {
            md.appendMarkdown(`### $(package) **${targetPkg.name}** \`${targetPkg.version}\`\n\n`);

            md.appendMarkdown(`| Detail | Value |\n`);
            md.appendMarkdown(`| :--- | :--- |\n`);
            md.appendMarkdown(`| **Locked Version** | \`${targetPkg.version}\` |\n`);
            md.appendMarkdown(`| **Kind** | \`${targetPkg.kind || 'conda'}\` |\n`);
            if (targetPkg.build) {
                md.appendMarkdown(`| **Build** | \`${targetPkg.build}\` |\n`);
            }
            const spec = matched.requestedSpec || targetPkg.requested_spec;
            if (spec) {
                md.appendMarkdown(`| **Requested Spec** | \`${spec}\` |\n`);
            }
            if (targetPkg.license) {
                md.appendMarkdown(`| **License** | \`${targetPkg.license}\` |\n`);
            }
            if (targetPkg.source) {
                md.appendMarkdown(`| **Source** | \`${targetPkg.source}\` |\n`);
            }
            if (targetPkg.is_local) {
                const localInfo = targetPkg.local_path
                    ? `${targetPkg.local_path} ${targetPkg.is_editable ? '(editable)' : ''}`
                    : targetPkg.is_editable
                      ? 'editable'
                      : 'local';
                md.appendMarkdown(`| **Local** | \`${localInfo}\` |\n`);
            }

            md.appendMarkdown(
                `\n**Environment**: \`${foundEnvName}\`${foundEnvName === activeEnvName ? ' (active)' : ''}\n\n`,
            );

            // Highlight differences across other environments if any
            if (envVersions.size > 1) {
                const diffVersions = Array.from(envVersions.entries()).filter(
                    ([env, p]) =>
                        env !== foundEnvName && (p.version !== targetPkg?.version || p.build !== targetPkg?.build),
                );
                if (diffVersions.length > 0) {
                    md.appendMarkdown(`**Other Environments:**\n`);
                    for (const [env, p] of diffVersions) {
                        const buildSuffix = p.build ? ` (\`${p.build}\`)` : '';
                        md.appendMarkdown(`- \`${env}\`: \`${p.version}\`${buildSuffix}\n`);
                    }
                    md.appendMarkdown(`\n`);
                }
            }

            const actions: string[] = [];
            if (lockExists) {
                const openLockArgs = encodeURIComponent(JSON.stringify([{ projectPath, packageName: matched.name }]));
                actions.push(
                    `[$(go-to-file) Open in pixi.lock](command:pixi.openLockfile?${openLockArgs} "Jump to package definition in pixi.lock")`,
                );
            }

            if (!targetPkg.is_local && !targetPkg.is_editable) {
                if (targetPkg.kind === 'pypi' || matched.section.toLowerCase().includes('pypi')) {
                    const pypiUrl = `https://pypi.org/project/${encodeURIComponent(targetPkg.name)}/`;
                    actions.push(`[$(link-external) PyPI](${pypiUrl} "Open package on PyPI")`);
                } else {
                    const chMatch = targetPkg.source?.match(/conda\.anaconda\.org\/([^/]+)/);
                    const channel = chMatch ? chMatch[1] : 'conda-forge';
                    const prefixUrl = `https://prefix.dev/channels/${channel}/packages/${encodeURIComponent(targetPkg.name)}`;
                    actions.push(`[$(link-external) prefix.dev](${prefixUrl} "Open package on prefix.dev")`);
                }
            }

            if (actions.length > 0) {
                md.appendMarkdown(`---\n${actions.join(' &nbsp;&nbsp;|&nbsp;&nbsp; ')}`);
            }
        }

        const highlightRange = new Range(matched.nameRange.start, matched.valueRange.end);
        return new Hover(md, highlightRange);
    }

    /**
     * Provide Definition (Ctrl/Cmd + Click) to navigate directly to the package record in pixi.lock.
     */
    public async provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
    ): Promise<Definition | undefined> {
        const projectPath = this.projectManager.findProjectForUri(document.uri);
        if (!projectPath) {
            return undefined;
        }

        const deps = this.parseManifestDependencies(document);
        if (deps.length === 0 || token.isCancellationRequested) {
            return undefined;
        }

        const matched = deps.find(
            (d) =>
                d.line === position.line &&
                ((position.character >= d.nameRange.start.character &&
                    position.character <= d.nameRange.end.character) ||
                    (position.character >= d.valueRange.start.character &&
                        position.character <= d.valueRange.end.character)),
        );

        if (!matched || token.isCancellationRequested) {
            return undefined;
        }

        const lockPath = path.join(projectPath, 'pixi.lock');
        if (!fs.existsSync(lockPath)) {
            return undefined;
        }

        const targetLine = await findPackageLineInLockfile(lockPath, matched.name);
        if (targetLine < 0 || token.isCancellationRequested) {
            return undefined;
        }

        return new Location(Uri.file(lockPath), new Position(targetLine, 0));
    }

    /**
     * Helper to open pixi.lock, optionally jumping directly to a package's line.
     */
    public async openLockfileCommand(options?: { projectPath?: string; packageName?: string } | Uri): Promise<void> {
        let projectPath: string | undefined;
        let packageName: string | undefined;

        if (options instanceof Uri) {
            projectPath = this.projectManager.findProjectForUri(options);
        } else if (options && typeof options === 'object') {
            projectPath = options.projectPath;
            packageName = options.packageName;
        }

        if (!projectPath) {
            const activeDoc = window.activeTextEditor?.document;
            if (activeDoc) {
                projectPath = this.projectManager.findProjectForUri(activeDoc.uri);
            }
        }

        if (!projectPath) {
            const paths = this.projectManager.getProjectPaths();
            if (paths.length > 0) {
                projectPath = paths[0];
            }
        }

        if (!projectPath) {
            window.showWarningMessage('No Pixi project found in workspace.');
            return;
        }

        const lockPath = path.join(projectPath, 'pixi.lock');
        if (!fs.existsSync(lockPath)) {
            window.showWarningMessage(`No pixi.lock found in ${projectPath}`);
            return;
        }

        try {
            const doc = await workspace.openTextDocument(Uri.file(lockPath));
            const editor = await window.showTextDocument(doc);

            if (packageName) {
                const targetLine = await findPackageLineInLockfile(lockPath, packageName);
                if (targetLine >= 0) {
                    const pos = new Position(targetLine, 0);
                    editor.selection = new Selection(pos, pos);
                    editor.revealRange(new Range(pos, pos), TextEditorRevealType.InCenter);
                }
            }
        } catch (error) {
            window.showErrorMessage(
                `Failed to open lockfile: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private createPackageMap(packages: PixiPackage[]): Map<string, PixiPackage> {
        const map = new Map<string, PixiPackage>();
        for (const pkg of packages) {
            map.set(pkg.name.toLowerCase(), pkg);
            map.set(normalizePkgName(pkg.name), pkg);
        }
        return map;
    }

    private lookupPackage(map: Map<string, PixiPackage>, name: string): PixiPackage | undefined {
        return map.get(name.toLowerCase()) || map.get(normalizePkgName(name));
    }

    private createInlayHint(dep: ParsedDependency, pkg: PixiPackage, envName: string, projectPath: string): InlayHint {
        const tag = pkg.is_editable ? ' (editable)' : pkg.is_local ? ' (local)' : '';

        const md = new MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;
        md.appendMarkdown(`**${pkg.name}** \`${pkg.version}\`\n\n`);
        if (pkg.kind) {
            md.appendMarkdown(`- **Type**: \`${pkg.kind}\`\n`);
        }
        if (pkg.build) {
            md.appendMarkdown(`- **Build**: \`${pkg.build}\`\n`);
        }
        if (pkg.license) {
            md.appendMarkdown(`- **License**: \`${pkg.license}\`\n`);
        }
        md.appendMarkdown(`- **Environment**: \`${envName}\`\n\n`);
        md.appendMarkdown(`*Click to view in \`pixi.lock\`*`);

        const part = new InlayHintLabelPart(`: ${pkg.version}${tag}`);
        part.tooltip = md;
        part.command = {
            title: 'Open in pixi.lock',
            command: 'pixi.openLockfile',
            arguments: [{ projectPath, packageName: dep.name }],
        };

        const hint = new InlayHint(dep.insertPosition, [part], InlayHintKind.Type);
        hint.paddingLeft = true;
        hint.paddingRight = false;

        return hint;
    }
}
