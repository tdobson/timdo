/**
 * The ref parser: every input rule from the task refs spec, plus the labels and limits.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalRef,
  defaultLabel,
  hasControlChars,
  KIND_PATTERN,
  parseRef,
  REF_ROLES,
  ROLE_LABELS,
  shortRefLabel,
  urlForKnownKind,
} from './refs';

function ok(input: string, kind?: string) {
  const result = parseRef(input, kind);
  if (!result.ok) {
    throw new Error(`Expected "${input}" to parse, got: ${result.error}`);
  }
  return result.value;
}

function err(input: string, kind?: string) {
  const result = parseRef(input, kind);
  if (result.ok) {
    throw new Error(`Expected "${input}" to fail, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

describe('parseRef', () => {
  it('rule 1: an explicit kind takes the input as the id', () => {
    expect(ok('123456', 'acme.member')).toEqual({
      kind: 'acme.member',
      ref: '123456',
      url: null,
      label: 'acme.member:123456',
    });
    expect(ok('  acme/widgets#12 ', 'github.issue')).toMatchObject({
      ref: 'acme/widgets#12',
      url: 'https://github.com/acme/widgets/issues/12',
    });
    expect(err('x', 'Bad Kind')).toMatch(/kind/i);
    expect(err('   ', 'acme.member')).toMatch(/kind:id/);
    // URL schemes are never kinds, so an explicit one can't build a fake-looking URL ref
    for (const scheme of ['http', 'https', 'mailto', 'HTTP']) {
      expect(err('//evil.example', scheme)).toBe(
        'http, https and mailto are not kinds: paste the whole link instead'
      );
    }
  });

  it('rule 2: GitHub issue and PR URLs, normalised', () => {
    expect(ok('https://github.com/acme/widgets/issues/12?x=1#c')).toEqual({
      kind: 'github.issue',
      ref: 'acme/widgets#12',
      url: 'https://github.com/acme/widgets/issues/12',
      label: 'GitHub issue acme/widgets#12',
    });
    expect(ok('https://github.com/acme/widgets/pull/7')).toEqual({
      kind: 'github.pr',
      ref: 'acme/widgets#7',
      url: 'https://github.com/acme/widgets/pull/7',
      label: 'GitHub PR acme/widgets#7',
    });
    expect(ok('https://github.com/acme/widgets/pull/7/files')).toMatchObject({
      kind: 'github.pr',
      url: 'https://github.com/acme/widgets/pull/7',
    });
    // Anything else on GitHub is just a URL
    expect(ok('https://github.com/acme/widgets').kind).toBe('url');
  });

  it('rule 3: Gmail thread URLs, but not the newer opaque ids', () => {
    expect(ok('https://mail.google.com/mail/u/0/#inbox/1a11f9b5ec8c2b2f')).toEqual({
      kind: 'gmail.thread',
      ref: '1a11f9b5ec8c2b2f',
      url: 'https://mail.google.com/mail/u/0/#inbox/1a11f9b5ec8c2b2f',
      label: 'Gmail thread',
    });
    expect(ok('https://mail.google.com/mail/u/1/#label/Clients/1a11f9b5ec8c2b2f').ref).toBe(
      '1a11f9b5ec8c2b2f'
    );
    expect(ok('https://mail.google.com/mail/u/0/#all/1a11f9b5ec8c2b2f').kind).toBe('gmail.thread');
    expect(ok('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWxyz').kind).toBe('url');
  });

  it('rule 4: Sentry issue URLs keep the URL as given', () => {
    expect(ok('https://acme.sentry.io/issues/4242/')).toEqual({
      kind: 'sentry.issue',
      ref: '4242',
      url: 'https://acme.sentry.io/issues/4242/',
      label: 'Sentry issue 4242',
    });
    expect(ok('https://sentry.io/organizations/acme/issues/99/?project=1')).toMatchObject({
      kind: 'sentry.issue',
      ref: '99',
      url: 'https://sentry.io/organizations/acme/issues/99/?project=1',
    });
  });

  it('rule 5: email addresses, lowercased, with no URL', () => {
    const expected = {
      kind: 'email',
      ref: 'robin@example.com',
      url: null,
      label: 'robin@example.com',
    };
    expect(ok('mailto:Robin@Example.com')).toEqual(expected);
    expect(ok('Robin@Example.com')).toEqual(expected);
    expect(ok('mailto:robin@example.com?subject=Hello')).toEqual(expected);
  });

  it('rule 6: any other web address is a url ref with a short label', () => {
    expect(ok('https://forum.example.org/t/broken-offer/4411')).toEqual({
      kind: 'url',
      ref: 'https://forum.example.org/t/broken-offer/4411',
      url: 'https://forum.example.org/t/broken-offer/4411',
      label: 'forum.example.org/t/broken-offer/4411',
    });
    const long = `https://example.org/${'a'.repeat(100)}`;
    const label = ok(long).label;
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.startsWith('example.org/aaa')).toBe(true);
    expect(ok('http://example.org/').label).toBe('example.org');
  });

  it('rule 7: kind:ref, with URLs built for known kinds', () => {
    expect(ok('acme.member:123456')).toEqual({
      kind: 'acme.member',
      ref: '123456',
      url: null,
      label: 'acme.member:123456',
    });
    expect(ok('github.issue:acme/widgets#12')).toEqual({
      kind: 'github.issue',
      ref: 'acme/widgets#12',
      url: 'https://github.com/acme/widgets/issues/12',
      label: 'GitHub issue acme/widgets#12',
    });
    expect(ok('github.pr:acme/widgets#7').url).toBe('https://github.com/acme/widgets/pull/7');
    expect(ok('gmail.thread:1a11f9b5ec8c2b2f').url).toBe(
      'https://mail.google.com/mail/u/0/#all/1a11f9b5ec8c2b2f'
    );
    // The id keeps its case and everything after the first colon
    expect(ok('forum.post:Ab:12').ref).toBe('Ab:12');
  });

  it('rule 8: anything else is an error with a helpful sentence', () => {
    const message =
      "Can't tell what that is. Paste a URL, or write it as kind:id, e.g. acme.member:123456";
    expect(err('just some words')).toBe(message);
    expect(err('')).toBe(message);
    expect(err('http:foo')).toBe(message);
    expect(err('mailto:not-an-address')).toBe(message);
  });

  it('trims, checks case and enforces the limits', () => {
    expect(ok('  forum.post:4411  ')).toMatchObject({ kind: 'forum.post', ref: '4411' });
    expect(err('Forum.Post:1')).toMatch(/lowercase/);
    expect(err(`forum.post:${'x'.repeat(501)}`)).toMatch(/500/);
    expect(ok(`forum.post:${'x'.repeat(500)}`).ref).toHaveLength(500);
    expect(err(`${'a'.repeat(65)}:1`)).toMatch(/64/);
    expect(err(`https://example.org/${'a'.repeat(500)}`)).toMatch(/500/);
  });

  it('rejects line breaks, tabs and other control characters', () => {
    const message = "Links can't contain line breaks, tabs or control characters";
    expect(err('forum.post:44\n11')).toBe(message);
    expect(err('forum.post:44\u001b[2J')).toBe(message);
    expect(err('forum.post:44\t11')).toBe(message);
    expect(err('forum.post:44\u007f')).toBe(message);
    expect(err('https://example.org/a\u0000b')).toBe(message);
    expect(err('44\n11', 'forum.post')).toBe(message);
    expect(err('4411', 'forum.post\n')).toBe(message);
    // Surrounding whitespace, newlines included, is trimmed first
    expect(ok('\n forum.post:4411 \n').ref).toBe('4411');
    expect(hasControlChars('Robin\u001b[31m')).toBe(true);
    expect(hasControlChars('Robin Fairweather')).toBe(false);
  });

  it('lowercases GitHub owner/repo and Gmail hex ids so one thing has one ref', () => {
    const issue = {
      kind: 'github.issue',
      ref: 'acme/widgets#12',
      url: 'https://github.com/acme/widgets/issues/12',
      label: 'GitHub issue acme/widgets#12',
    };
    expect(ok('https://github.com/Acme/Widgets/issues/12')).toEqual(issue);
    expect(ok('github.issue:Acme/Widgets#12')).toEqual(issue);
    expect(ok('Acme/Widgets#12', 'github.issue')).toEqual(issue);
    expect(ok('https://github.com/Acme/Widgets/pull/7').ref).toBe('acme/widgets#7');
    expect(ok('https://mail.google.com/mail/u/0/#inbox/1A11F9B5EC8C2B2F').ref).toBe(
      '1a11f9b5ec8c2b2f'
    );
    expect(ok('gmail.thread:1A11F9B5EC8C2B2F').url).toBe(
      'https://mail.google.com/mail/u/0/#all/1a11f9b5ec8c2b2f'
    );
    // Other kinds, and ids in other shapes, keep their case
    expect(ok('gmail.thread:FMfcgzQXJWxyz').ref).toBe('FMfcgzQXJWxyz');
    expect(ok('github.issue:Not A Shape').ref).toBe('Not A Shape');
  });
});

describe('helpers', () => {
  it('exports the roles, labels and kind pattern', () => {
    expect(REF_ROLES).toEqual(['link', 'source', 'reported_by', 'about']);
    expect(ROLE_LABELS.reported_by).toBe('Reported by');
    expect(KIND_PATTERN.test('acme.member')).toBe(true);
    expect(KIND_PATTERN.test('Acme')).toBe(false);
  });

  it('builds canonical forms, URLs and labels', () => {
    expect(canonicalRef({ kind: 'forum.post', ref: '4411' })).toBe('forum.post:4411');
    expect(urlForKnownKind('acme.member', '1')).toBeNull();
    expect(urlForKnownKind('url', 'https://example.org/x')).toBe('https://example.org/x');
    expect(urlForKnownKind('github.issue', 'not a repo')).toBeNull();
    expect(defaultLabel('sentry.issue', '123')).toBe('Sentry issue 123');
    expect(defaultLabel('acme.member', '123456')).toBe('acme.member:123456');
  });

  it('gives board chips a short label', () => {
    expect(shortRefLabel('github.issue', 'acme/widgets#12')).toBe('#12');
    expect(shortRefLabel('github.pr', 'acme/widgets#7')).toBe('PR 7');
    expect(shortRefLabel('acme.member', '123456')).toBe('123456');
    expect(shortRefLabel('url', 'https://forum.example.org/t/x/4411')).toBe('forum.example.org');
    expect(shortRefLabel('acme.member', 'x'.repeat(40)).length).toBeLessThanOrEqual(24);
  });
});
