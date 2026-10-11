export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value?: T | PromiseLike<T>): void;
    reject(reason?: string | Error | Record<string, unknown> | unknown): void;
}

class DeferredImpl<T> implements Deferred<T> {
    promise: Promise<T>;
    private _resolve!: (value: T | PromiseLike<T>) => void;
    private _reject!: (reason?: string | Error | Record<string, unknown> | unknown) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    resolve(value: T | PromiseLike<T>): void {
        this._resolve(value);
    }

    reject(reason?: string | Error | Record<string, unknown> | unknown): void {
        this._reject(reason);
    }
}

export function createDeferred<T>(): Deferred<T> {
    return new DeferredImpl<T>();
}
