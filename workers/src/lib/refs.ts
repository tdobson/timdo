/**
 * Task refs: pointers from a task to things outside TimDo (issues, posts, mail, members).
 *
 * A ref is `{ kind, ref }`, written canonically as `kind:ref` (`github.issue:acme/widgets#12`,
 * `acme.member:123456`). This module turns what someone pasted or typed into that form. It is
 * pure (no imports) so the worker, the web app and the voice pipeline all share one parser.
 */

export const REF_ROLES = ['link', 'source', 'reported_by', 'about'] as const;
export type RefRole = (typeof REF_ROLES)[number];

export const ROLE_LABELS: Record<RefRole, string> = {
  link: 'Link',
  source: 'Source',
  reported_by: 'Reported by',
  about: 'About',
};

export const ROLE_ERROR = 'Role must be link, source, reported_by or about';

/** "reported-by", "Reported by" and "reported_by" all mean the same role; empty means link. */
export function normaliseRole(role: string | null | undefined): RefRole | null {
  if (role === undefined || role === null || role.trim() === '') {
    return 'link';
  }
  const r = role
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (REF_ROLES as readonly string[]).indexOf(r) >= 0 ? (r as RefRole) : null;
}

/** Lowercase dotted slug, `system.type` by convention. Unknown kinds are allowed. */
export const KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export const MAX_KIND_LENGTH = 64;
export const MAX_REF_LENGTH = 500;
export const MAX_LABEL_LENGTH = 200;

export interface ParsedRef {
  kind: string;
  ref: string;
  url: string | null;
  label: string;
}

export type ParseResult = { ok: true; value: ParsedRef } | { ok: false; error: string };

export const PARSE_ERROR =
  "Can't tell what that is. Paste a URL, or write it as kind:id, e.g. acme.member:123456";

// Schemes that look like `kind:ref` but never are
const RESERVED_KINDS = ['http', 'https', 'mailto'];

/** Line breaks, tabs, escape and the other C0 controls, plus DEL. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const CONTROL_ERROR = "Links can't contain line breaks, tabs or control characters";
export const LABEL_CONTROL_ERROR = "Labels can't contain line breaks, tabs or control characters";

/** True when text holds a character that could break a table row or a terminal. */
export function hasControlChars(text: string): boolean {
  return CONTROL_CHARS.test(text);
}

const GITHUB_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/(issues|pull)\/(\d+)(?:[/?#]\S*)?$/i;
const GITHUB_REF = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const GMAIL_URL = /^https?:\/\/mail\.google\.com\/mail\/[^#\s]*#\S*\/([0-9a-f]{16})$/i;
const SENTRY_URL =
  /^https?:\/\/(?:[a-z0-9-]+\.sentry\.io\/issues\/(\d+)|(?:[a-z0-9-]+\.)?sentry\.io\/organizations\/[^/\s]+\/issues\/(\d+))(?:[/?#]\S*)?$/i;
const WEB_URL = /^https?:\/\/([^/?#\s]+)([^?#\s]*)(?:[?#]\S*)?$/i;
const EMAIL = /^[^\s@:/<>]+@[^\s@:/<>]+\.[^\s@:/<>]+$/;

export function canonicalRef(r: { kind: string; ref: string }): string {
  return `${r.kind}:${r.ref}`;
}

/**
 * Ids that their system treats case-insensitively, lowercased so one thing has one ref.
 * GitHub owner and repo names ignore case; Gmail's classic thread ids are hex.
 */
function normaliseKnownId(kind: string, ref: string): string {
  if (kind === 'github.issue' || kind === 'github.pr') {
    const m = GITHUB_REF.exec(ref);
    return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}#${m[3]}` : ref;
  }
  if (kind === 'gmail.thread' && /^[0-9a-f]{16}$/i.test(ref)) {
    return ref.toLowerCase();
  }
  return ref;
}

function ok(kind: string, rawRef: string, url: string | null): ParseResult {
  const ref = normaliseKnownId(kind, rawRef);
  if (ref.length > MAX_REF_LENGTH) {
    return {
      ok: false,
      error: `That is too long: ids and URLs can be ${MAX_REF_LENGTH} characters at most`,
    };
  }
  return { ok: true, value: { kind, ref, url, label: defaultLabel(kind, ref, url) } };
}

function kindError(kind: string): string | null {
  if (RESERVED_KINDS.indexOf(kind.toLowerCase()) >= 0) {
    return 'http, https and mailto are not kinds: paste the whole link instead';
  }
  if (kind.length > MAX_KIND_LENGTH) {
    return `That kind is too long: kinds can be ${MAX_KIND_LENGTH} characters at most`;
  }
  if (!KIND_PATTERN.test(kind)) {
    if (KIND_PATTERN.test(kind.toLowerCase())) {
      return `Kinds are lowercase: write ${kind.toLowerCase()}`;
    }
    return 'A kind is lowercase letters, digits and dots, e.g. acme.member';
  }
  return null;
}

/** A ref whose URL, if any, comes from its kind (after the id is normalised). */
function okKnown(kind: string, rawRef: string): ParseResult {
  const ref = normaliseKnownId(kind, rawRef);
  return ok(kind, ref, urlForKnownKind(kind, ref));
}

/** "example.org/some/path", shortened to 60 characters. */
function shortUrl(url: string): string {
  const m = WEB_URL.exec(url);
  if (!m) {
    return url.length > 60 ? `${url.slice(0, 57)}...` : url;
  }
  const text = `${m[1].toLowerCase()}${m[2].replace(/\/+$/, '')}`;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The URL a known kind points at, or null (unknown kinds, or an id in the wrong shape). */
export function urlForKnownKind(kind: string, ref: string): string | null {
  if (kind === 'github.issue' || kind === 'github.pr') {
    const m = GITHUB_REF.exec(ref);
    if (!m) {
      return null;
    }
    return `https://github.com/${m[1]}/${m[2]}/${kind === 'github.pr' ? 'pull' : 'issues'}/${m[3]}`;
  }
  if (kind === 'gmail.thread') {
    return /^[^\s/#?]+$/.test(ref) ? `https://mail.google.com/mail/u/0/#all/${ref}` : null;
  }
  if (kind === 'url') {
    return /^https?:\/\/\S+$/i.test(ref) ? ref : null;
  }
  return null;
}

/** What a ref is called when nobody gave it a label. */
export function defaultLabel(kind: string, ref: string, url?: string | null): string {
  switch (kind) {
    case 'github.issue':
      return `GitHub issue ${ref}`;
    case 'github.pr':
      return `GitHub PR ${ref}`;
    case 'gmail.thread':
      return 'Gmail thread';
    case 'sentry.issue':
      return `Sentry issue ${ref}`;
    case 'email':
      return ref;
    case 'url':
      return shortUrl(url || ref);
    default:
      return canonicalRef({ kind, ref });
  }
}

/** A few characters for a board card chip: '#12', 'PR 7', '4411', 'example.org'. */
export function shortRefLabel(kind: string, ref: string): string {
  let text = ref;
  if (kind === 'github.issue' || kind === 'github.pr') {
    const hash = ref.lastIndexOf('#');
    const n = hash >= 0 ? ref.slice(hash + 1) : ref;
    text = kind === 'github.pr' ? `PR ${n}` : `#${n}`;
  } else if (kind === 'url') {
    const m = WEB_URL.exec(ref);
    text = m ? m[1].toLowerCase() : ref;
  } else if (kind === 'gmail.thread') {
    text = 'Gmail';
  }
  return text.length > 24 ? `${text.slice(0, 21)}...` : text;
}

/**
 * Turn pasted or typed text into a ref. Rules, in order: an explicit kind; GitHub issue and
 * PR URLs; Gmail thread URLs; Sentry issue URLs; email addresses; any other web address;
 * `kind:ref`. Anything else is an error sentence fit to show a person, as is any input
 * holding line breaks, tabs or other control characters (once trimmed).
 */
export function parseRef(input: string, explicitKind?: string): ParseResult {
  const text = (input ?? '').trim();
  if (hasControlChars(text) || (explicitKind && hasControlChars(explicitKind))) {
    return { ok: false, error: CONTROL_ERROR };
  }

  // 1. Explicit kind: the whole input is the id
  if (explicitKind !== undefined && explicitKind !== null && explicitKind.trim() !== '') {
    const kind = explicitKind.trim();
    const problem = kindError(kind);
    if (problem) {
      return { ok: false, error: problem };
    }
    if (!text) {
      return { ok: false, error: PARSE_ERROR };
    }
    return okKnown(kind, text);
  }
  if (!text) {
    return { ok: false, error: PARSE_ERROR };
  }

  // 2. GitHub issues and pull requests, normalised to the canonical URL
  const gh = GITHUB_URL.exec(text);
  if (gh) {
    const kind = gh[3].toLowerCase() === 'pull' ? 'github.pr' : 'github.issue';
    const ref = `${gh[1]}/${gh[2]}#${gh[4]}`;
    return okKnown(kind, ref);
  }

  // 3. Gmail threads with a classic hex id (the opaque FMfcg... ids fall through to url)
  const gmail = GMAIL_URL.exec(text);
  if (gmail) {
    return ok('gmail.thread', gmail[1], text);
  }

  // 4. Sentry issues, URL kept as given
  const sentry = SENTRY_URL.exec(text);
  if (sentry) {
    return ok('sentry.issue', sentry[1] || sentry[2], text);
  }

  // 5. Email addresses
  const address = /^mailto:/i.test(text) ? text.slice(7).split('?')[0] : text;
  if (EMAIL.test(address)) {
    return ok('email', address.toLowerCase(), null);
  }
  if (/^mailto:/i.test(text)) {
    return { ok: false, error: PARSE_ERROR };
  }

  // 6. Any other web address
  if (/^https?:\/\//i.test(text)) {
    return WEB_URL.test(text) ? ok('url', text, text) : { ok: false, error: PARSE_ERROR };
  }

  // 7. kind:ref
  const colon = text.indexOf(':');
  if (colon > 0) {
    const kind = text.slice(0, colon);
    const ref = text.slice(colon + 1).trim();
    if (RESERVED_KINDS.indexOf(kind.toLowerCase()) >= 0 || /\s/.test(kind)) {
      return { ok: false, error: PARSE_ERROR };
    }
    const problem = kindError(kind);
    if (problem) {
      // Only explain kind rules when it plausibly was meant as one
      return { ok: false, error: /^[a-z0-9_.]+$/i.test(kind) ? problem : PARSE_ERROR };
    }
    if (!ref) {
      return { ok: false, error: PARSE_ERROR };
    }
    return okKnown(kind, ref);
  }

  // 8. Not something we can read
  return { ok: false, error: PARSE_ERROR };
}
