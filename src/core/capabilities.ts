import { Capabilities, SessionType } from './protocol';

export function patchCapabilities(body: Capabilities, _sessionType: SessionType): Capabilities {
  const patched: Capabilities = { ...body };
  patched.supportsConditionalBreakpoints = false;
  patched.supportsHitConditionalBreakpoints = false;
  patched.supportsLogPoints = false;
  patched.supportsTerminateThreadsRequest = false;
  patched.supportsStepBack = false;
  patched.exceptionBreakpointFilters = [];
  delete patched.completionTriggerCharacters;
  delete patched.additionalModuleColumns;
  delete patched.supportedChecksumAlgorithms;
  return patched;
}
