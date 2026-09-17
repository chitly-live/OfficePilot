import { describe, expect, it } from 'vitest';

import { maskContacts, maskEmail, maskPhone, shouldMaskContacts } from './mask';

describe('maskPhone', () => {
  it('keeps only the last two digits and preserves formatting', () => {
    expect(maskPhone('+919673072005')).toBe('+XXXXXXXXXX05');
    expect(maskPhone('+91 96730 72005')).toBe('+XX XXXXX XXX05');
    expect(maskPhone('8287695073')).toBe('XXXXXXXX73');
  });

  it('handles short / empty values', () => {
    expect(maskPhone('7')).toBe('7');
    expect(maskPhone('42')).toBe('42');
    expect(maskPhone('abc')).toBe('XXXX');
    expect(maskPhone('')).toBeNull();
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
  });
});

describe('maskEmail', () => {
  it('keeps the first three characters and the TLD only', () => {
    expect(maskEmail('twinklwnkr@gmail.com')).toBe('twi***@***.com');
    expect(maskEmail('shubhamkumar.cm@gmail.com')).toBe('shu***@***.com');
    expect(maskEmail('ab@x.co.in')).toBe('ab***@***.in');
  });

  it('handles odd input', () => {
    expect(maskEmail('noatsign')).toBe('noa***@***');
    expect(maskEmail('')).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });
});

describe('maskContacts', () => {
  const party = { id: 'p1', name: 'Tinkal', phone: '+919673072005', email: 'twinklwnkr@gmail.com' };

  it('masks for accountants only', () => {
    expect(shouldMaskContacts('ACCOUNTANT')).toBe(true);
    expect(shouldMaskContacts('ADMIN')).toBe(false);
    expect(shouldMaskContacts('EMPLOYEE')).toBe(false);
    expect(maskContacts(party, 'ADMIN')).toBe(party);
    expect(maskContacts(party, 'ACCOUNTANT')).toEqual({
      ...party,
      phone: '+XXXXXXXXXX05',
      email: 'twi***@***.com',
    });
  });

  it('leaves rows without contact fields alone', () => {
    const row: { id: string; name: string; phone?: string | null } = { id: 'x', name: 'n' };
    expect(maskContacts(row, 'ACCOUNTANT')).toEqual(row);
  });
});
