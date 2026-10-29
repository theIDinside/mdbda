import { Request, Response } from './protocol';

export function blockedResponse(request: Request, message = `${request.command} is not supported by mdb`): Response {
	return {
		seq: 0,
		type: 'response',
		request_seq: request.seq,
		command: request.command,
		success: false,
		message,
	};
}
