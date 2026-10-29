import * as assert from 'assert';
import { MessageReader, encodeMessage } from '../../core/framing';

suite('DAP framing', () => {
	test('reads one message', () => {
		const reader = new MessageReader();
		const messages: unknown[] = [];
		reader.on('message', (message) => messages.push(message));
		reader.push(encodeMessage({ seq: 1, command: 'initialize' }));
		assert.deepStrictEqual(messages, [{ seq: 1, command: 'initialize' }]);
	});

	test('reads two messages in one chunk', () => {
		const reader = new MessageReader();
		const messages: unknown[] = [];
		reader.on('message', (message) => messages.push(message));
		reader.push(Buffer.concat([encodeMessage({ seq: 1 }), encodeMessage({ seq: 2 })]));
		assert.deepStrictEqual(messages, [{ seq: 1 }, { seq: 2 }]);
	});

	test('reads a message split across chunks in the header and a UTF-8 character', () => {
		const reader = new MessageReader();
		const messages: unknown[] = [];
		reader.on('message', (message) => messages.push(message));
		const frame = encodeMessage({ event: 'output', output: 'åäö🙂' });
		const splitAt = frame.indexOf(Buffer.from('å')) + 1;
		reader.push(frame.subarray(0, 8));
		reader.push(frame.subarray(8, splitAt));
		reader.push(frame.subarray(splitAt));
		assert.deepStrictEqual(messages, [{ event: 'output', output: 'åäö🙂' }]);
	});

	test('reports garbage before a header and continues parsing', () => {
		const reader = new MessageReader();
		const messages: unknown[] = [];
		const garbage: string[] = [];
		reader.on('message', (message) => messages.push(message));
		reader.on('garbage', (text: string) => garbage.push(text));
		reader.push(Buffer.concat([Buffer.from('TODO: not implemented\n'), encodeMessage({ seq: 3 })]));
		assert.deepStrictEqual(garbage, ['TODO: not implemented\n']);
		assert.deepStrictEqual(messages, [{ seq: 3 }]);
	});

	test('reports invalid JSON and continues with the next message', () => {
		const reader = new MessageReader();
		const errors: string[] = [];
		const messages: unknown[] = [];
		reader.on('error', (payload: string) => errors.push(payload));
		reader.on('message', (message) => messages.push(message));
		const invalid = Buffer.from('not-json');
		const malformedFrame = Buffer.concat([Buffer.from(`Content-Length: ${invalid.length}\r\n\r\n`), invalid]);
		reader.push(Buffer.concat([malformedFrame, encodeMessage({ seq: 4 })]));
		assert.deepStrictEqual(errors, ['not-json']);
		assert.deepStrictEqual(messages, [{ seq: 4 }]);
	});

	test('uses UTF-8 byte length in the header', () => {
		const frame = encodeMessage({ output: 'åäö🙂' }).toString('utf8');
		const [header, payload] = frame.split('\r\n\r\n');
		assert.strictEqual(header, `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`);
	});

	test('accepts additional headers before the blank line', () => {
		const payload = JSON.stringify({ seq: 5 });
		const reader = new MessageReader();
		const messages: unknown[] = [];
		reader.on('message', (message) => messages.push(message));
		reader.push(Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\nX-Test: yes\r\n\r\n${payload}`));
		assert.deepStrictEqual(messages, [{ seq: 5 }]);
	});
});
