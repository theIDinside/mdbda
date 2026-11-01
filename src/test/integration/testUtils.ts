export function PrepareStacktrace(errorMessage: string, fn: Function): Error {
  const err = new Error(errorMessage);
  Error.captureStackTrace(err, fn);
  return err;
}