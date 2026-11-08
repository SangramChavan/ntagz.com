// One error shape for every new endpoint (docs/platform/CONTRACTS.md section 4). Never leak SQL, stack traces or secrets.
const STATUS = { VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, INTERNAL: 500 };

export class AppError extends Error {
  constructor(code, message, fields) {
    super(message || code);
    this.code = STATUS[code] ? code : 'INTERNAL';
    this.status = STATUS[this.code];
    this.fields = fields || undefined;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export function ok(data, extra = {}, status = 200) {
  return new Response(JSON.stringify({ ok: true, data, ...extra }), { status, headers: JSON_HEADERS });
}

export function fail(err, requestId) {
  const e = err instanceof AppError ? err : new AppError('INTERNAL', 'Something went wrong');
  const error = { code: e.code, message: e.status === 500 ? 'Something went wrong' : e.message, requestId };
  if (e.fields) error.fields = e.fields;
  return new Response(JSON.stringify({ ok: false, error }), { status: e.status, headers: JSON_HEADERS });
}
