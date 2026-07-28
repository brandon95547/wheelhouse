import type { NextFunction, Request, Response } from 'express';

/** An error carrying an HTTP status and, optionally, per-field detail. */
export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);

export const notFound = (message = 'Resource not found') =>
  new HttpError(404, message);

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not found',
    message: `No route matches ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // SQLite constraint failures are usually a client mistake, not a server bug.
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('SQLITE_CONSTRAINT')) {
    res.status(409).json({ error: 'Database constraint failed', message });
    return;
  }

  console.error('[wheelhouse] unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: 'Something went wrong handling this request.',
  });
}
