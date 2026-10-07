export function isExcludedPath(path: string, matcher?: ((path: string) => boolean) | null): boolean;
export function isSupportedSource(path: string): boolean;
export function compileIgnore(text: string): (path: string) => boolean;
export function redactSecrets(text: string): string;
