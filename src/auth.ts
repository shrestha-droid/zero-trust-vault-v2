// Pure helpers for the sign-in flow (unit-tested in auth.test.ts).

/** Supabase's raw errors read like API responses; show something a person can act on. */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (/rate limit|too many|only request this after|security purposes/.test(m)) return 'Too many attempts. Wait a minute, then try again.';
  if (/code verifier|pkce|flow state/.test(m)) return 'That link was opened in a different browser than the one you started in. Enter the 6-digit code from the email here instead.';
  if (/expired|invalid.*(token|otp|code)|token.*invalid/.test(m)) return 'That code is wrong or has expired. Check the latest email, or request a new code.';
  if (/provider.*(not enabled|disabled)|unsupported provider/.test(m)) return "That sign-in method isn't turned on yet. Use email instead.";
  if (/failed to fetch|network|load failed/.test(m)) return "Can't reach the sign-in service. Check your connection and try again.";
  return message;
}

export const isEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.trim());

/** Codes are pasted with spaces or dashes ("123 456"); keep digits only. Returns null unless it looks like a code. */
export function cleanCode(s: string): string | null {
  const d = s.replace(/[\s-]/g, '');
  return /^\d{6,10}$/.test(d) ? d : null;
}
