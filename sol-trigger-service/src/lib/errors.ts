export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 404, 'not_found');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'validation_error', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'conflict', details);
  }
}

/** Generation allowance for the order is used up. Does not consume a retry attempt. */
export class BudgetError extends AppError {
  constructor(message: string) {
    super(message, 402, 'budget_exhausted');
  }
}

/** A credential, input or upstream artefact is missing. Does not consume a retry attempt. */
export class SetupRequiredError extends AppError {
  constructor(message: string) {
    super(message, 424, 'setup_required');
  }
}

/** A publication exists (or may exist) but its public page could not be confirmed yet. */
export class NotVerifiedError extends AppError {
  constructor(message: string) {
    super(message, 425, 'not_verified');
  }
}

export class UpstreamError extends AppError {
  constructor(message: string) {
    super(message, 502, 'upstream_error');
  }
}

export const isBlocking = (err: unknown) => err instanceof BudgetError || err instanceof SetupRequiredError;
