import { ExtensionContext } from 'vscode';

export interface PersistentState {
    get<T>(key: string, defaultValue?: T): T | undefined;
    set<T>(key: string, value: T): Thenable<void>;
}

const fallbackStore = new Map<string, unknown>();

let _workspace: PersistentState = {
    get: <T>(key: string, defaultValue?: T) => (fallbackStore.has(key) ? (fallbackStore.get(key) as T) : defaultValue),
    set: async <T>(key: string, value: T) => {
        if (value === undefined) {
            fallbackStore.delete(key);
        } else {
            fallbackStore.set(key, value);
        }
    },
};

export function setPersistentState(context: ExtensionContext): void {
    _workspace = {
        get: <T>(key: string, defaultValue?: T) => context.workspaceState.get<T>(key, defaultValue as T),
        set: <T>(key: string, value: T) => context.workspaceState.update(key, value),
    };
}

export function getWorkspacePersistentState(): PersistentState {
    return _workspace;
}
