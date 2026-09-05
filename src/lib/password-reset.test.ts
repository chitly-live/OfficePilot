/**
 * Unit tests for `src/lib/password-reset.ts` — token generation and
 * hashing, expiry maths, base-URL resolution, link building, and the
 * reset email bodies. No I/O.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  PASSWORD_RESET_TTL_MINUTES,
  PASSWORD_RESET_TTL_MS,
  buildResetEmail,
  buildResetUrl,
  escapeHtml,
  generateResetToken,
  hashResetToken,
  isResetTokenUsable,
  normalizeBaseUrl,
  resetTokenExpiry,
  resolveAppBaseUrl,
} from './password-reset';

describe('generateResetToken / hashResetToken', () => {
  it('produces a 43-char base64url token whose hash is its sha256 hex', () => {
    const { raw, hash } = generateResetToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetToken(raw)).toBe(hash);
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateResetToken().raw);
    expect(seen.size).toBe(200);
  });

  it('hashing is deterministic and input-sensitive', () => {
    expect(hashResetToken('abc')).toBe(hashResetToken('abc'));
    expect(hashResetToken('abc')).not.toBe(hashResetToken('abd'));
  });
});

describe('expiry', () => {
  const now = new Date('2026-09-06T10:00:00.000Z');

  it('resetTokenExpiry adds the TTL', () => {
    expect(resetTokenExpiry(now).getTime()).toBe(now.getTime() + PASSWORD_RESET_TTL_MS);
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(30);
  });

  it('isResetTokenUsable: unused + future expiry → true', () => {
    expect(
      isResetTokenUsable({ expiresAt: new Date(now.getTime() + 1), usedAt: null }, now),
    ).toBe(true);
  });

  it('isResetTokenUsable: used → false', () => {
    expect(
      isResetTokenUsable(
        { expiresAt: new Date(now.getTime() + 60_000), usedAt: new Date(now) },
        now,
      ),
    ).toBe(false);
  });

  it('isResetTokenUsable: expired, including the exact expiry instant → false', () => {
    expect(isResetTokenUsable({ expiresAt: now, usedAt: null }, now)).toBe(false);
    expect(
      isResetTokenUsable({ expiresAt: new Date(now.getTime() - 1), usedAt: null }, now),
    ).toBe(false);
  });
});

describe('normalizeBaseUrl / resolveAppBaseUrl', () => {
  const saved = {
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    AUTH_URL: process.env.AUTH_URL,
  };

  afterEach(() => {
    if (saved.NEXTAUTH_URL === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = saved.NEXTAUTH_URL;
    if (saved.AUTH_URL === undefined) delete process.env.AUTH_URL;
    else process.env.AUTH_URL = saved.AUTH_URL;
  });

  it('trims and strips trailing slashes', () => {
    expect(normalizeBaseUrl(' https://officepilot.chitly.live/// ')).toBe(
      'https://officepilot.chitly.live',
    );
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('rejects empty, scheme-less and non-http values', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl('localhost:3000')).toBeNull();
    expect(normalizeBaseUrl('ftp://x.y')).toBeNull();
  });

  it('prefers NEXTAUTH_URL, then AUTH_URL, then the request origin, then localhost', () => {
    process.env.NEXTAUTH_URL = 'https://a.example/';
    process.env.AUTH_URL = 'https://b.example';
    expect(resolveAppBaseUrl('https://c.example')).toBe('https://a.example');

    delete process.env.NEXTAUTH_URL;
    expect(resolveAppBaseUrl('https://c.example')).toBe('https://b.example');

    delete process.env.AUTH_URL;
    expect(resolveAppBaseUrl('https://c.example')).toBe('https://c.example');

    expect(resolveAppBaseUrl(undefined)).toBe('http://localhost:3000');
    process.env.NEXTAUTH_URL = '   ';
    expect(resolveAppBaseUrl(null)).toBe('http://localhost:3000');
  });
});

describe('buildResetUrl', () => {
  it('joins without a double slash and URL-encodes the token', () => {
    expect(buildResetUrl('https://officepilot.chitly.live/', 'ab_c-d')).toBe(
      'https://officepilot.chitly.live/reset-password?token=ab_c-d',
    );
    expect(buildResetUrl('http://localhost:3000', 'a+b/c=')).toBe(
      'http://localhost:3000/reset-password?token=a%2Bb%2Fc%3D',
    );
  });
});

describe('escapeHtml / buildResetEmail', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe(
      '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;',
    );
  });

  it('includes the link in both bodies and escapes the name in HTML only', () => {
    const url = 'https://officepilot.chitly.live/reset-password?token=abc';
    const mail = buildResetEmail({ name: '<script>Rahul</script>', resetUrl: url });

    expect(mail.subject).toBe('Reset your OfficePilot password');
    expect(mail.html).toContain(`href="${url}"`);
    expect(mail.html).toContain('&lt;script&gt;Rahul&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('30 minutes');

    expect(mail.text).toContain(url);
    expect(mail.text).toContain('<script>Rahul</script>');
    expect(mail.text).toContain('30 minutes');
  });

  it('falls back to a neutral greeting for a blank name and honours ttlMinutes', () => {
    const mail = buildResetEmail({ name: '   ', resetUrl: 'https://x.y/reset-password?token=t', ttlMinutes: 5 });
    expect(mail.html).toContain('Hi there,');
    expect(mail.text).toContain('Hi there,');
    expect(mail.html).toContain('5 minutes');
  });
});
