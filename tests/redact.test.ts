import { describe, expect, it } from 'vitest';
import { MASK, maskPersonalData, redactSecrets, scrubText } from '../src/privacy/redact.js';

describe('maskPersonalData', () => {
  const employee = {
    id: '1c7f3d2b-aaaa-4bbb-8ccc-ddddeeeeffff',
    name: 'Test Person',
    nationalID: '010190-1234',
    nationalIDType: 'DK CPR',
    tin: '123',
    bankRegistrationNumber: '1234',
    bankAccountNumber: '5678901234',
    address: 'Vej 1',
    postalCode: '8000',
    city: 'Aarhus',
    email: 'a@b.dk',
    phoneNumber: '12345678',
    birthDate: '1990-01-01',
    calendarFeedKey: 'secret-feed',
    note: 'CPR 0101901234, konto 1234-5678901234, IBAN DK50 0040 0440 1162 43',
    activeContract: { nested: [{ nationalId: 'x', amount: 1234567 }] },
  };

  it('masks identifiers, drops personal fields, keeps the rest', () => {
    const out = maskPersonalData(employee) as Record<string, unknown>;
    expect(out).toMatchObject({ id: employee.id, name: 'Test Person', nationalIDType: 'DK CPR', nationalID: MASK, tin: MASK, bankAccountNumber: MASK, bankRegistrationNumber: MASK });
    for (const k of ['address', 'postalCode', 'city', 'email', 'phoneNumber', 'birthDate', 'calendarFeedKey']) expect(out).not.toHaveProperty(k);
    expect(out.activeContract).toEqual({ nested: [{ nationalId: MASK, amount: 1234567 }] });
    const text = JSON.stringify(out);
    for (const s of ['0101901234', '010190', '5678901234', 'DK50', 'secret-feed']) expect(text).not.toContain(s);
  });

  it('does not mangle UUIDs, dates or amounts', () => {
    const v = { id: '0b5e1c2a-3d4f-4a6b-8c7d-9e0f1a2b3c4d', from: '2026-01-01', amount: 1234567890, text: 'Period 2026-01-01 to 2026-01-31' };
    expect(maskPersonalData(v)).toEqual(v);
  });

  it('does not mutate its input', () => {
    const v = { nationalID: '010190-1234' };
    maskPersonalData(v);
    expect(v.nationalID).toBe('010190-1234');
  });
});

describe('scrubText', () => {
  it.each(['010190-1234', '0101901234', '311299 1234', '1234-5678901234', '1234 567890', 'DK5000400440116243'])('masks %s', (s) => {
    expect(scrubText(`x ${s} y`)).toBe(`x ${MASK} y`);
  });
  it('leaves an invalid day/month alone', () => {
    expect(scrubText('991390-1234')).toBe('991390-1234');
  });
});

describe('redactSecrets', () => {
  it('removes headers, key-value secrets, long tokens and known secret values', () => {
    const secret = 'mysecretvalue123';
    const line = `Authorization: abc123 apiKey=xyz token:"qwe" ${'z'.repeat(64)} has ${secret}`;
    const out = redactSecrets(line, [secret]);
    for (const s of ['abc123', 'xyz', 'qwe', 'z'.repeat(64), secret]) expect(out).not.toContain(s);
  });
});

describe('scrubFreeText', () => {
  it('also masks e-mail and Danish phone numbers', async () => {
    const { scrubFreeText } = await import('../src/privacy/redact.js');
    expect(scrubFreeText('ring +45 12 34 56 78 eller a.b@firma.dk')).toBe('ring [masked] eller [masked]');
    expect(scrubFreeText('2026-10-01 7.4 timer')).toBe('2026-10-01 7.4 timer');
  });
});
