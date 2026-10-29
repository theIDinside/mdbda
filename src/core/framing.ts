import { EventEmitter } from 'events';

export class MessageReader extends EventEmitter {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);

		while (this.buffer.length > 0) {
			const headerStart = this.buffer.indexOf('Content-Length:');
			if (headerStart < 0) {
				const possiblePrefix = this.longestHeaderPrefixSuffix();
				const garbageLength = this.buffer.length - possiblePrefix;
				if (garbageLength > 0) {
					this.emit('garbage', this.buffer.subarray(0, garbageLength).toString('utf8'));
					this.buffer = this.buffer.subarray(garbageLength);
				}
				return;
			}

			if (headerStart > 0) {
				this.emit('garbage', this.buffer.subarray(0, headerStart).toString('utf8'));
				this.buffer = this.buffer.subarray(headerStart);
			}

			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				return;
			}

			const header = this.buffer.subarray(0, headerEnd).toString('ascii');
			const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(`${header}\r\n`);
			if (!lengthMatch) {
				this.emit('garbage', this.buffer.subarray(0, headerEnd + 4).toString('utf8'));
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}

			const payloadLength = Number(lengthMatch[1]);
			const frameLength = headerEnd + 4 + payloadLength;
			if (!Number.isSafeInteger(payloadLength) || this.buffer.length < frameLength) {
				return;
			}

			const payload = this.buffer.subarray(headerEnd + 4, frameLength).toString('utf8');
			this.buffer = this.buffer.subarray(frameLength);
			let message: unknown;
			try {
				message = JSON.parse(payload);
			} catch {
				this.emit('error', payload);
				continue;
			}
			this.emit('message', message);
		}
	}

	private longestHeaderPrefixSuffix(): number {
		const marker = 'Content-Length:';
		const max = Math.min(this.buffer.length, marker.length - 1);
		for (let length = max; length > 0; length -= 1) {
			if (this.buffer.subarray(this.buffer.length - length).equals(Buffer.from(marker.slice(0, length)))) {
				return length;
			}
		}
		return 0;
	}
}

export function encodeMessage(obj: unknown): Buffer {
	const json = JSON.stringify(obj);
	return Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
}
