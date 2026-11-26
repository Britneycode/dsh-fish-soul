declare module 'node:sqlite' {
	export class DatabaseSync {
		constructor(path: string, options?: any);
		prepare(sql: string): {
			get(...args: any[]): any;
			all(...args: any[]): any[];
			run(...args: any[]): { changes: number; lastInsertRowid: number | bigint };
		};
		exec(sql: string): void;
		close(): void;
	}
}

declare module 'node:crypto' {
	export function createHash(algorithm: string): any;
	export function randomUUID(): string;
}

declare module 'node:fs' {
	export function existsSync(p: any): boolean;
	export function mkdirSync(p: any, opts?: any): any;
	export function readdirSync(p: any, opts?: any): any[];
	export function readFileSync(p: any, opts?: any): any;
	export function writeFileSync(p: any, data: any, opts?: any): void;
	export function statSync(p: any): any;
	export function renameSync(oldPath: any, newPath: any): void;
	export function unlinkSync(p: any): void;
	export const promises: any;
}

declare module 'node:path' {
	export function join(...paths: string[]): string;
	export function resolve(...paths: string[]): string;
	export function dirname(p: string): string;
	export function extname(p: string): string;
	export function basename(p: string, ext?: string): string;
}

declare module 'node:os' {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module 'node:events' {
	export class EventEmitter {
		on(event: any, listener: (...args: any[]) => void): any;
		off(event: any, listener: (...args: any[]) => void): any;
		emit(event: any, ...args: any[]): boolean;
	}
}

declare module 'node:module' {
	export function createRequire(url: any): any;
}

declare class Buffer extends Uint8Array {
	static from(value: any, encoding?: any): Buffer;
	static alloc(size: number, fill?: any): Buffer;
	static isBuffer(obj: any): obj is Buffer;
	toString(encoding?: string): string;
}

declare const process: {
	env: Record<string, string | undefined>;
	cwd(): string;
	platform: string;
	versions: Record<string, string>;
	[key: string]: any;
};

declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(timeoutId: any): void;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearInterval(intervalId: any): void;
