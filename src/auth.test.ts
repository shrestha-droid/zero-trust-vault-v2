import { describe, expect, it } from 'vitest';
import { cleanCode, friendlyAuthError, isEmail } from './auth.js';

describe('auth helpers', () => {
  it('turns raw Supabase errors into actionable text, and leaves unknown ones alone', () => {
    expect(friendlyAuthError('email rate limit exceeded')).toMatch(/Wait a minute/);
    expect(friendlyAuthError('For security purposes, you can only request this after 42 seconds.')).toMatch(/Wait a minute/);
    expect(friendlyAuthError('Token has expired or is invalid')).toMatch(/new code/);
    expect(friendlyAuthError('invalid request: both auth code and code verifier should be non-empty')).toMatch(/different browser/);
    expect(friendlyAuthError('Failed to fetch')).toMatch(/connection/);
    expect(friendlyAuthError('Something new')).toBe('Something new');
  });
  it('accepts pasted codes with separators and rejects everything else', () => {
    expect(cleanCode('123456')).toBe('123456');
    expect(cleanCode(' 123 456 ')).toBe('123456');
    expect(cleanCode('123-456')).toBe('123456');
    expect(cleanCode('12345')).toBeNull();
    expect(cleanCode('12345a')).toBeNull();
    expect(cleanCode('')).toBeNull();
  });
  it('validates emails loosely (the server is the real check)', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail(' a@b.co ')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('a b@c.co')).toBe(false);
  });
});
