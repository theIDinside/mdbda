export class LineBuffer {
	private buffer = '';

	push(chunk: string, emit: (line: string) => void): void {
		this.buffer += chunk;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? '';
		for (const line of lines) {
			emit(line);
		}
	}

	flush(emit: (line: string) => void): void {
		if (this.buffer.length > 0) {
			emit(this.buffer);
			this.buffer = '';
		}
	}
}
