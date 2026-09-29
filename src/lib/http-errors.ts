/**
 * HTTP-shaped errors thrown by route handlers and the libraries they call.
 * Kept free of any auth / Next.js import so pure libraries (and their unit
 * tests) can throw them; `errorResponse` in `api-helpers` maps each one to
 * its status code, and `api-helpers` re-exports them for existing callers.
 */

import type { ZodError } from 'zod';

export class UnauthorizedError extends Error {
  readonly code = 'unauthorized' as const;

  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/**
 * Thrown when JSON parsing fails or the schema rejects the body. Keeps
 * Zod errors first-class (kept on `.zodError`) so `errorResponse(...)`
 * can attach structured `issues` to the 400 payload.
 */
export class BadRequestError extends Error {
  readonly code = 'bad_request' as const;
  readonly zodError?: ZodError;

  constructor(message = 'Bad request', zodError?: ZodError) {
    super(message);
    this.name = 'BadRequestError';
    this.zodError = zodError;
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

/**
 * The request is valid but clashes with what is already stored — a month
 * that has been closed, a row that looks like one already entered. `reason`
 * becomes the `error` code the client branches on; `details` travels with it
 * (e.g. the rows it may duplicate) so the UI can show them.
 */
/**
 * An employee asked for a module their admin has not granted (or the
 * accountant asked for anything outside Finance). Same body the middleware
 * sends, so clients see one shape whichever layer refused.
 */
export class ModuleAccessError extends Error {
  readonly code = 'module_access_denied' as const;
  readonly module: string;

  constructor(module: string) {
    super(`No access to the ${module} module`);
    this.name = 'ModuleAccessError';
    this.module = module;
    Object.setPrototypeOf(this, ModuleAccessError.prototype);
  }
}

export class ConflictError extends Error {
  readonly code = 'conflict' as const;
  readonly reason: string;
  readonly details?: Record<string, unknown>;

  constructor(reason: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConflictError';
    this.reason = reason;
    this.details = details;
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}
