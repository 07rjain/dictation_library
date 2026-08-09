export class DictationError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, options: { code: string; status?: number; details?: unknown; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "DictationError";
    this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
    if (options.details !== undefined) this.details = options.details;
  }
}
