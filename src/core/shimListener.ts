import { EventEmitter } from 'events';
import * as net from 'net';

// Wire format version 1 of the mdb_shim handoff, see dbm's .handoff/child-process-launch/spec.md.
const shimMagic = Buffer.from([0x4d, 0x44, 0x42, 0x53, 0x48, 0x49, 0x4d, 0x00]);
const shimHeaderSize = 16;
const shimVersion = 1;
const maxShimPayload = 1024 * 1024;
const maxShimArguments = 4096;
const maxErrorPayload = 4096;

const enum ShimMessage {
  Hello = 1,
  Go = 2,
  Error = 3,
}

export interface ShimHello {
	pid: number;
	argv: string[];
}

export function parseShimHello(payload: Buffer): ShimHello {
  if (payload.length < 8) {
    throw new Error('Shim hello payload is truncated');
  }
  const pid = payload.readUInt32BE(0);
  const argumentCount = payload.readUInt32BE(4);
  if (pid === 0 || argumentCount === 0 || argumentCount > maxShimArguments) {
    throw new Error('Shim hello has invalid pid/argc');
  }
  let offset = 8;
  const argv: string[] = [];
  for (let index = 0; index < argumentCount; index++) {
    if (offset + 4 > payload.length) {
      throw new Error('Shim hello argument length is truncated');
    }
    const length = payload.readUInt32BE(offset);
    offset += 4;
    if (offset + length > payload.length) {
      throw new Error('Shim hello argument is truncated');
    }
    argv.push(payload.subarray(offset, offset + length).toString('utf8'));
    offset += length;
  }
  if (offset !== payload.length) {
    throw new Error('Shim hello has trailing data');
  }
  return { pid, argv };
}

export function shimFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(shimHeaderSize);
  shimMagic.copy(header, 0);
  header.writeUInt16BE(shimVersion, 8);
  header[10] = type;
  header.writeUInt32BE(payload.length, 12);
  return Buffer.concat([header, payload]);
}

export function shimHelloFrame(hello: ShimHello): Buffer {
  const parts: Buffer[] = [];
  const fixed = Buffer.alloc(8);
  fixed.writeUInt32BE(hello.pid, 0);
  fixed.writeUInt32BE(hello.argv.length, 4);
  parts.push(fixed);
  for (const argument of hello.argv) {
    const bytes = Buffer.from(argument, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(length, bytes);
  }
  return shimFrame(ShimMessage.Hello, Buffer.concat(parts));
}

/** One shim that connected to the listener. It is answered once, with go or error. */
export class ShimConnection extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private answered = false;
  hello: ShimHello | undefined;

  constructor(private readonly socket: net.Socket) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => this.emit('closed'));
  }

  get closed(): boolean {
    return this.socket.destroyed;
  }

  go(): void {
    this.answer(shimFrame(ShimMessage.Go));
  }

  error(message: string): void {
    this.answer(shimFrame(ShimMessage.Error, Buffer.from(message, 'utf8').subarray(0, maxErrorPayload)));
  }

  destroy(): void {
    this.socket.destroy();
  }

  private answer(frame: Buffer): void {
    if (this.answered || this.socket.destroyed) {
      return;
    }
    this.answered = true;
    this.socket.end(frame);
  }

  private onData(chunk: Buffer): void {
    if (this.hello) {
      this.reject('Shim sent unexpected data after hello');
      return;
    }
    if (this.buffer.length + chunk.length > shimHeaderSize + maxShimPayload) {
      this.reject('Shim hello exceeds the payload limit');
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length < shimHeaderSize) {
      return;
    }
    const header = this.buffer.subarray(0, shimHeaderSize);
    if (!header.subarray(0, 8).equals(shimMagic) || header.readUInt16BE(8) !== shimVersion
      || header[10] !== ShimMessage.Hello || header[11] !== 0) {
      this.reject('Invalid shim hello header');
      return;
    }
    const payloadLength = header.readUInt32BE(12);
    if (payloadLength > maxShimPayload) {
      this.reject('Shim hello exceeds the payload limit');
      return;
    }
    if (this.buffer.length < shimHeaderSize + payloadLength) {
      return;
    }
    if (this.buffer.length !== shimHeaderSize + payloadLength) {
      this.reject('Shim sent unexpected data after hello');
      return;
    }
    try {
      this.hello = parseShimHello(this.buffer.subarray(shimHeaderSize));
    } catch (error) {
      this.reject(error instanceof Error ? error.message : String(error));
      return;
    }
    this.emit('hello', this.hello);
  }

  private reject(message: string): void {
    this.emit('invalid', message);
    this.error(message);
    this.socket.destroy();
  }
}

/**
 * Listens on a Unix socket for mdb_shim handoffs. Emits `connection(ShimConnection)` for every shim; the
 * connection emits `hello(ShimHello)`, `invalid(message)` and `closed`.
 */
export class ShimListener extends EventEmitter {
  private readonly server = net.createServer((socket) => this.emit('connection', new ShimConnection(socket)));

  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
