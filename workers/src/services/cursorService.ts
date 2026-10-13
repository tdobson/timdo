export type CursorDomain = 'events' | 'activity';

interface CursorBase {
  v: 1;
  d: CursorDomain;
  p: string;
  s: string;
  f: string;
  h: string;
}

export interface EventsCursorPayload extends CursorBase {
  d: 'events';
  a: string;
}

export interface ActivityCursorPayload extends CursorBase {
  d: 'activity';
  b: { t: string | null; i: string };
}

export type CursorPayload = EventsCursorPayload | ActivityCursorPayload;

export class CursorError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    readonly code: 'invalid_cursor' | 'stale_cursor' | 'cursor_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'CursorError';
  }
}

export const MAX_ACTIVITY_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_CURSOR_LENGTH = 2048;
const encoder = new TextEncoder();

function unavailable(): CursorError {
  return new CursorError(503, 'cursor_unavailable', 'Opaque cursors are unavailable');
}

function invalidCursor(): CursorError {
  return new CursorError(400, 'invalid_cursor', 'The cursor is invalid or cannot be decrypted');
}

export function cursorScopeChanged(): CursorError {
  return new CursorError(
    409,
    'stale_cursor',
    'The cursor scope changed; restart from a fresh page'
  );
}

function decodeKey(key: string | undefined): Uint8Array {
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
    throw unavailable();
  }
  try {
    const standard = `${key.replace(/-/g, '+').replace(/_/g, '/')}=`;
    const decoded = atob(standard);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (bytes.length !== 32 || encodeBase64Url(bytes) !== key) {
      throw unavailable();
    }
    return bytes;
  } catch {
    throw unavailable();
  }
}

export function assertCursorKey(key: string | undefined): asserts key is string {
  decodeKey(key);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw invalidCursor();
  }
  try {
    const padded =
      value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) {
      throw invalidCursor();
    }
    return bytes;
  } catch {
    throw invalidCursor();
  }
}

export function encodeSequence(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_ACTIVITY_SEQUENCE) {
    throw invalidCursor();
  }
  return sequence.toString(16).padStart(16, '0');
}

export function decodeSequence(value: unknown): number {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) {
    throw invalidCursor();
  }
  const sequence = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_ACTIVITY_SEQUENCE) {
    throw invalidCursor();
  }
  return sequence;
}

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validatePayload(value: unknown, domain: CursorDomain): CursorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidCursor();
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.v !== 1 ||
    payload.d !== domain ||
    !isFingerprint(payload.p) ||
    !isFingerprint(payload.s) ||
    !isFingerprint(payload.f)
  ) {
    throw invalidCursor();
  }
  decodeSequence(payload.h);
  if (domain === 'events') {
    if (!exactKeys(payload, ['v', 'd', 'p', 's', 'f', 'h', 'a'])) {
      throw invalidCursor();
    }
    decodeSequence(payload.a);
    if (decodeSequence(payload.a) > decodeSequence(payload.h)) {
      throw invalidCursor();
    }
    return payload as unknown as EventsCursorPayload;
  }
  if (!exactKeys(payload, ['v', 'd', 'p', 's', 'f', 'h', 'b'])) {
    throw invalidCursor();
  }
  if (!payload.b || typeof payload.b !== 'object' || Array.isArray(payload.b)) {
    throw invalidCursor();
  }
  const before = payload.b as Record<string, unknown>;
  if (
    !exactKeys(before, ['t', 'i']) ||
    (before.t !== null && (typeof before.t !== 'string' || before.t.length > 100)) ||
    typeof before.i !== 'string' ||
    before.i.length < 1 ||
    before.i.length > 200
  ) {
    throw invalidCursor();
  }
  return payload as unknown as ActivityCursorPayload;
}

function additionalData(domain: CursorDomain) {
  return encoder.encode(`timdo-cursor:v1:${domain}`);
}

export async function encodeCursor(
  key: string | undefined,
  payload: CursorPayload
): Promise<string> {
  const rawKey = decodeKey(key);
  const checked = validatePayload(payload, payload.d);
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: additionalData(checked.d), tagLength: 128 },
      cryptoKey,
      encoder.encode(JSON.stringify(checked))
    )
  );
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  const cursor = `c1.${encodeBase64Url(combined)}`;
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }
  return cursor;
}

export async function decodeCursor(
  key: string | undefined,
  domain: CursorDomain,
  cursor: string
): Promise<CursorPayload> {
  const rawKey = decodeKey(key);
  if (
    typeof cursor !== 'string' ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !cursor.startsWith('c1.')
  ) {
    throw invalidCursor();
  }
  const bytes = decodeBase64Url(cursor.slice(3));
  if (bytes.length < 12 + 16) {
    throw invalidCursor();
  }
  const nonce = bytes.subarray(0, 12);
  const ciphertext = bytes.subarray(12);
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: additionalData(domain), tagLength: 128 },
      cryptoKey,
      ciphertext
    );
    const decoded = new TextDecoder().decode(plaintext);
    return validatePayload(JSON.parse(decoded), domain);
  } catch (error) {
    if (error instanceof CursorError) {
      throw error;
    }
    throw invalidCursor();
  }
}

export function assertCursorBinding(
  payload: CursorPayload,
  expected: { principal: string; scope: string; filters: string }
) {
  if (
    payload.p !== expected.principal ||
    payload.s !== expected.scope ||
    payload.f !== expected.filters
  ) {
    throw cursorScopeChanged();
  }
}

export function isCursorError(error: unknown): error is CursorError {
  return error instanceof CursorError;
}
