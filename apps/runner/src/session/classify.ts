export type PageResult =
  'signed-in' | 'signed-out' | 'security-check' | 'unexpected-page';
export type SessionResult = PageResult | 'stopped' | 'bridge-unavailable';

export const SIGN_IN_FORM = 'input#username, input[name="session_key"]';
export const CHALLENGE =
  'iframe[src*="captcha"], #captcha-internal, form[action*="checkpoint"]';

export interface PageSignals {
  path: string;
  signInForms: number;
  challenges: number;
}

export function classifySession(s: PageSignals): PageResult {
  if (s.path.startsWith('/checkpoint/') || s.challenges > 0) {
    return 'security-check';
  }
  if (
    s.path.startsWith('/login') ||
    s.path.startsWith('/uas/login') ||
    s.path.startsWith('/authwall') ||
    s.signInForms > 0
  ) {
    return 'signed-out';
  }
  if (s.path.startsWith('/feed')) return 'signed-in';
  return 'unexpected-page';
}
