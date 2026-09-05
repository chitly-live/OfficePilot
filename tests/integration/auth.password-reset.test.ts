/**
 * Integration tests for the self-service password reset flow:
 *
 *   POST /api/auth/forgot-password
 *   POST /api/auth/reset-password
 *
 * Real Postgres; the mailer is mocked at the module boundary so we can
 * read the emailed token straight out of the HTML body.
 *
 * Coverage:
 *   • unknown / inactive email → generic 200, no email
 *   • active user → one single-use token, email sent, audit row
 *   • rate limit (3 per hour), newest link retires older ones
 *   • reset happy path (hash changes, passwordChangedAt set, token used,
 *     audit row), then reuse → 400
 *   • expired / unknown / malformed tokens → 400; weak password → 400
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import { compare } from 'bcryptjs';

vi.mock('@/lib/mailer', () => ({
  sendMail: vi.fn(async () => ({ messageId: 'test-message-id' })),
}));

import { POST as forgotPassword } from '@/app/api/auth/forgot-password/route';
import { POST as resetPassword } from '@/app/api/auth/reset-password/route';
import { prisma } from '@/lib/db';
import { sendMail } from '@/lib/mailer';
import { hashResetToken } from '@/lib/password-reset';

import { buildJsonRequest, createTestUser, getJson } from './helpers';

const FORGOT = 'http://test/api/auth/forgot-password';
const RESET = 'http://test/api/auth/reset-password';

const sendMailMock = sendMail as unknown as Mock;

function emailedToken(callIndex = -1): string {
  const calls = sendMailMock.mock.calls;
  const args = (callIndex < 0 ? calls[calls.length + callIndex] : calls[callIndex])?.[0] as
    | { html: string }
    | undefined;
  if (!args) throw new Error('sendMail was not called');
  const match = /reset-password\?token=([A-Za-z0-9_%.-]+)/.exec(args.html);
  if (!match) throw new Error('no token in email');
  return decodeURIComponent(match[1]);
}

async function requestLink(email: string) {
  return forgotPassword(buildJsonRequest('POST', FORGOT, { email }));
}

async function submitReset(token: string, password: string) {
  return resetPassword(buildJsonRequest('POST', RESET, { token, password }));
}

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password
// ---------------------------------------------------------------------------

describe('POST /api/auth/forgot-password', () => {
  it('answers the generic 200 for an unknown email and sends nothing', async () => {
    const res = await requestLink('nobody@test.local');
    expect(res.status).toBe(200);
    expect(await getJson(res)).toMatchObject({ ok: true });
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('rejects a malformed email with 400', async () => {
    const res = await forgotPassword(buildJsonRequest('POST', FORGOT, { email: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('emails an active user one single-use link and audits the request', async () => {
    const { user } = await createTestUser({ email: 'host@test.local', name: 'Rahul' });

    const res = await requestLink('Host@Test.Local');
    expect(res.status).toBe(200);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailArgs = sendMailMock.mock.calls[0][0] as { to: string; subject: string; html: string; text: string };
    expect(mailArgs.to).toBe('host@test.local');
    expect(mailArgs.subject).toMatch(/reset your officepilot password/i);
    expect(mailArgs.html).toContain('/reset-password?token=');
    expect(mailArgs.text).toContain('/reset-password?token=');

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].usedAt).toBeNull();
    expect(rows[0].tokenHash).toBe(hashResetToken(emailedToken()));
    const ttlMs = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(29 * 60 * 1000);
    expect(ttlMs).toBeLessThan(31 * 60 * 1000);

    const log = await prisma.activityLog.findFirst({
      where: { action: 'user.password_reset_requested', userId: user.id },
    });
    expect(log).not.toBeNull();
    expect(log!.entityId).toBe(user.id);
  });

  it('does not email deactivated users', async () => {
    await createTestUser({ email: 'gone@test.local', isActive: false });
    const res = await requestLink('gone@test.local');
    expect(res.status).toBe(200);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('caps at 3 links per hour per account, still answering 200', async () => {
    await createTestUser({ email: 'busy@test.local' });
    for (let i = 0; i < 4; i += 1) {
      const res = await requestLink('busy@test.local');
      expect(res.status).toBe(200);
    }
    expect(sendMailMock).toHaveBeenCalledTimes(3);
    expect(await prisma.passwordResetToken.count()).toBe(3);
  });

  it('a newer link retires the older one', async () => {
    await createTestUser({ email: 'twice@test.local' });
    await requestLink('twice@test.local');
    const first = emailedToken(0);
    await requestLink('twice@test.local');
    const second = emailedToken(1);
    expect(first).not.toBe(second);

    const stale = await submitReset(first, 'BrandNewPass123');
    expect(stale.status).toBe(400);

    const fresh = await submitReset(second, 'BrandNewPass123');
    expect(fresh.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password
// ---------------------------------------------------------------------------

describe('POST /api/auth/reset-password', () => {
  it('sets the new password, stamps passwordChangedAt, consumes the token, audits — then rejects reuse', async () => {
    const { user, password: oldPassword } = await createTestUser({ email: 'reset@test.local' });
    await requestLink('reset@test.local');
    const token = emailedToken();

    const res = await submitReset(token, 'BrandNewPass123');
    expect(res.status).toBe(200);
    expect(await getJson(res)).toEqual({ ok: true });

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await compare('BrandNewPass123', updated.passwordHash)).toBe(true);
    expect(await compare(oldPassword, updated.passwordHash)).toBe(false);
    expect(updated.passwordChangedAt).not.toBeNull();

    const row = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashResetToken(token) },
    });
    expect(row.usedAt).not.toBeNull();

    const log = await prisma.activityLog.findFirst({
      where: { action: 'user.password_reset_completed', userId: user.id },
    });
    expect(log).not.toBeNull();

    const again = await submitReset(token, 'AnotherPass456');
    expect(again.status).toBe(400);
    const body = await getJson<{ message: string }>(again);
    expect(body?.message).toMatch(/invalid or has expired/i);
  });

  it('rejects an expired token', async () => {
    await createTestUser({ email: 'late@test.local' });
    await requestLink('late@test.local');
    const token = emailedToken();
    await prisma.passwordResetToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await submitReset(token, 'BrandNewPass123');
    expect(res.status).toBe(400);
  });

  it('rejects unknown and malformed tokens without touching any account', async () => {
    const { user, password } = await createTestUser({ email: 'safe@test.local' });

    const unknown = await submitReset('A'.repeat(43), 'BrandNewPass123');
    expect(unknown.status).toBe(400);

    const tooShort = await submitReset('short', 'BrandNewPass123');
    expect(tooShort.status).toBe(400);

    const stillOld = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await compare(password, stillOld.passwordHash)).toBe(true);
    expect(stillOld.passwordChangedAt).toBeNull();
  });

  it('rejects a weak password and leaves the token usable', async () => {
    await createTestUser({ email: 'weak@test.local' });
    await requestLink('weak@test.local');
    const token = emailedToken();

    const weak = await submitReset(token, 'short');
    expect(weak.status).toBe(400);

    const row = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashResetToken(token) },
    });
    expect(row.usedAt).toBeNull();

    const ok = await submitReset(token, 'LongEnoughPass1');
    expect(ok.status).toBe(200);
  });

  it('does not email or reset for a deactivated user even with a token minted earlier', async () => {
    const { user } = await createTestUser({ email: 'later-off@test.local' });
    await requestLink('later-off@test.local');
    const token = emailedToken();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const res = await submitReset(token, 'BrandNewPass123');
    expect(res.status).toBe(400);
  });
});
