/** Stable exit-code categories. Documented in README.md and SKILL.md; never renumber. */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1, // transport, server, or local environment failure
  USAGE: 2, // usage or validation failure
  NOT_FOUND: 3,
  CONFLICT: 4,
  AUTH: 5,
});

export class CliError extends Error {
  constructor(code, message, exitCode = EXIT.USAGE, extra = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.extra = extra;
  }
}

export function usage(message, extra) {
  return new CliError("INVALID_ARGUMENT", message, EXIT.USAGE, extra);
}
