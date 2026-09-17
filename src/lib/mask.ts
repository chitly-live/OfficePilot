/**
 * Contact masking for the ACCOUNTANT role.
 *
 * The accountant needs party names and amounts, not phone numbers or
 * email addresses. Everything here is pure and applied server-side (API
 * routes and server components) so the real values never leave the box.
 *
 *   maskPhone('+91 96730 72005') → '+XX XXXXX XXX05'   (last 2 digits kept)
 *   maskEmail('twinklwnkr@gmail.com') → 'twi***@***.com' (first 3 kept)
 */

import type { Role } from '@prisma/client';

/** Only accountants see masked contacts; admins see everything. */
export function shouldMaskContacts(role: Role | null | undefined): boolean {
  return role === 'ACCOUNTANT';
}

/** Every digit except the last two becomes `X`; other characters stay. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return 'XXXX';
  const keepFrom = Math.max(0, digits.length - 2);
  let seen = 0;
  return phone.replace(/\d/g, () => {
    const out = seen < keepFrom ? 'X' : digits[seen];
    seen += 1;
    return out;
  });
}

/** First three characters of the local part, then `***@***.<tld>`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at + 1) : '';
  const head = local.slice(0, Math.min(3, Math.max(2, local.length)));
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${head}***@***${tld}`;
}

/** Mask `phone` / `email` on any object when the viewer is an accountant. */
export function maskContacts<T extends { phone?: string | null; email?: string | null }>(
  row: T,
  role: Role | null | undefined,
): T {
  if (!shouldMaskContacts(role)) return row;
  return {
    ...row,
    ...('phone' in row ? { phone: maskPhone(row.phone) } : {}),
    ...('email' in row ? { email: maskEmail(row.email) } : {}),
  };
}
