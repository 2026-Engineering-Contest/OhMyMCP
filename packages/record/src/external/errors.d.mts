export type ExternalErrorCode =
  | "SESSION_ALREADY_EXISTS"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_RUNNING"
  | "INTERACTION_NOT_FOUND"
  | "INTERACTION_ALREADY_COMPLETE"
  | "CONCURRENT_MATCH"
  | "INCOMPLETE_SESSION"
  | "REPLAY_SOURCE_INVALID"
  | "REPLAY_MISS"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_INVALID"
  | "EXTERNAL_REDACTION_INVARIANT_VIOLATION"
  | "UNSUPPORTED_HTTP_METHOD"
  | "UNSUPPORTED_HTTP_URL"
  | "UNSUPPORTED_HTTP_BODY"
  | "UNSUPPORTED_HTTP_RESPONSE"
  | "HTTP_BODY_TOO_LARGE"
  | "COORDINATOR_UNAVAILABLE"
  | "COORDINATOR_TIMEOUT";

export class ExternalRecordReplayError extends Error {
  override readonly name: "ExternalRecordReplayError";
  readonly code: ExternalErrorCode;
  constructor(code: ExternalErrorCode, message: string);
}

export function externalError(code: ExternalErrorCode, message: string): never;
