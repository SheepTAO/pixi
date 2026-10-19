import * as path from 'path';

/**
 * Normalizes a filesystem path to a canonical lookup key.
 * On Windows, paths are case-insensitive and slash-normalized with trailing slashes trimmed.
 */
export function toCanonicalPathKey(filePath: string): string {
    const isWindows = process.platform === 'win32';
    const norm = isWindows ? filePath.replace(/\//g, '\\') : filePath;
    const normalized = path.normalize(norm);
    const parsed = path.parse(normalized);
    const trimmed = parsed.root === normalized ? normalized : normalized.replace(/[/\\]+$/, '');
    return isWindows ? trimmed.toLowerCase() : trimmed;
}

/**
 * Backward compatibility alias for toCanonicalPathKey.
 */
export const getProjectKey = toCanonicalPathKey;

/**
 * Compares two filesystem paths for equality, honoring platform case sensitivity.
 */
export function isSamePath(pathA?: string | null, pathB?: string | null): boolean {
    if (!pathA || !pathB) {
        return pathA === pathB;
    }
    return toCanonicalPathKey(pathA) === toCanonicalPathKey(pathB);
}

/**
 * Checks if a child path is located within (or is equal to) a parent directory, honoring platform case sensitivity.
 */
export function isPathInside(childPath?: string | null, parentDir?: string | null): boolean {
    if (!childPath || !parentDir) {
        return false;
    }
    const canonChild = toCanonicalPathKey(childPath);
    const canonParent = toCanonicalPathKey(parentDir);
    if (canonChild === canonParent) {
        return true;
    }
    const sep = process.platform === 'win32' ? '\\' : path.sep;
    if (canonParent.endsWith(sep)) {
        return canonChild.startsWith(canonParent);
    }
    return canonChild.startsWith(canonParent + sep);
}

/**
 * A Map implementation where keys are filesystem paths.
 * Supports case-insensitive, slash-normalized lookups on Windows while preserving the original path casing for keys().
 */
export class PathMap<V> implements Map<string, V> {
    private readonly canonicalToOriginal = new Map<string, string>();
    private readonly canonicalToValue = new Map<string, V>();
    private readonly canonicalToEntry = new Map<string, [string, V]>();

    constructor(entries?: Iterable<readonly [string, V]> | null) {
        if (entries) {
            for (const [key, value] of entries) {
                this.set(key, value);
            }
        }
    }

    public get size(): number {
        return this.canonicalToValue.size;
    }

    public get(key: string): V | undefined {
        return this.canonicalToValue.get(toCanonicalPathKey(key));
    }

    public set(key: string, value: V): this {
        const canonicalKey = toCanonicalPathKey(key);
        this.canonicalToOriginal.set(canonicalKey, key);
        this.canonicalToValue.set(canonicalKey, value);
        const existingEntry = this.canonicalToEntry.get(canonicalKey);
        if (existingEntry) {
            existingEntry[0] = key;
            existingEntry[1] = value;
        } else {
            this.canonicalToEntry.set(canonicalKey, [key, value]);
        }
        return this;
    }

    public has(key: string): boolean {
        return this.canonicalToValue.has(toCanonicalPathKey(key));
    }

    public delete(key: string): boolean {
        const canonicalKey = toCanonicalPathKey(key);
        this.canonicalToOriginal.delete(canonicalKey);
        this.canonicalToEntry.delete(canonicalKey);
        return this.canonicalToValue.delete(canonicalKey);
    }

    public clear(): void {
        this.canonicalToOriginal.clear();
        this.canonicalToValue.clear();
        this.canonicalToEntry.clear();
    }

    public keys(): MapIterator<string> {
        return this.canonicalToOriginal.values();
    }

    public values(): MapIterator<V> {
        return this.canonicalToValue.values();
    }

    public entries(): MapIterator<[string, V]> {
        return this.canonicalToEntry.values();
    }

    public [Symbol.iterator](): MapIterator<[string, V]> {
        return this.entries();
    }

    public forEach(callbackfn: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this.canonicalToEntry.values()) {
            callbackfn.call(thisArg, value, key, this);
        }
    }

    public get [Symbol.toStringTag](): string {
        return 'PathMap';
    }
}

/**
 * A Set implementation where items are filesystem paths.
 * Supports case-insensitive, slash-normalized membership checks on Windows while preserving the original path casing for values().
 */
export class PathSet implements Set<string> {
    private readonly originalSet = new Set<string>();
    private readonly canonicalToOriginal = new Map<string, string>();

    constructor(values?: Iterable<string> | null) {
        if (values) {
            for (const value of values) {
                this.add(value);
            }
        }
    }

    public get size(): number {
        return this.originalSet.size;
    }

    public add(value: string): this {
        const canonicalKey = toCanonicalPathKey(value);
        if (!this.canonicalToOriginal.has(canonicalKey)) {
            this.canonicalToOriginal.set(canonicalKey, value);
            this.originalSet.add(value);
        }
        return this;
    }

    public has(value: string): boolean {
        return this.canonicalToOriginal.has(toCanonicalPathKey(value));
    }

    public delete(value: string): boolean {
        const canonicalKey = toCanonicalPathKey(value);
        const original = this.canonicalToOriginal.get(canonicalKey);
        if (original !== undefined) {
            this.canonicalToOriginal.delete(canonicalKey);
            return this.originalSet.delete(original);
        }
        return false;
    }

    public clear(): void {
        this.canonicalToOriginal.clear();
        this.originalSet.clear();
    }

    public keys(): SetIterator<string> {
        return this.originalSet.keys();
    }

    public values(): SetIterator<string> {
        return this.originalSet.values();
    }

    public entries(): SetIterator<[string, string]> {
        return this.originalSet.entries();
    }

    public [Symbol.iterator](): SetIterator<string> {
        return this.originalSet[Symbol.iterator]();
    }

    public forEach(callbackfn: (value: string, value2: string, set: Set<string>) => void, thisArg?: unknown): void {
        for (const val of this.originalSet) {
            callbackfn.call(thisArg, val, val, this);
        }
    }

    public get [Symbol.toStringTag](): string {
        return 'PathSet';
    }
}

