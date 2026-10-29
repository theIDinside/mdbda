export interface Logger {
	trace(msg: string): void;
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export const nullLogger: Logger = {
	trace: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

export const consoleLogger: Logger = {
	trace: (msg) => console.debug(msg),
	info: (msg) => console.info(msg),
	warn: (msg) => console.warn(msg),
	error: (msg) => console.error(msg),
};
