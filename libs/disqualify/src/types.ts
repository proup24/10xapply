export const RULE_KINDS = [
  'offers-sponsorship',
  'requires-authorization',
  'no-sponsorship',
  'asks-authorization',
  'asks-sponsorship',
  'offers-relocation',
  'requires-location',
  'asks-location',
] as const;
/** Job-page kinds that exempt form questions: sponsorship and relocation offers. */
export const OFFER_KINDS = ['offers-sponsorship', 'offers-relocation'] as const;
export const LOG_KINDS = [
  'location-preference',
  'language-requirement',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type ClaimKind = RuleKind | (typeof LOG_KINDS)[number];
/** 'job-page', or a form question's id (`s2-q3`, `s2-u1` for an unknown field). */
export type ClaimSource = string;
export interface Claim {
  kind: ClaimKind;
  /** Codes or region names as the model gave them; [] = unclear (rule kinds) or none (language). */
  countries: string[];
  countryFrom: 'text' | 'job-description';
  /** Verbatim from the source's text. */
  quote: string;
  /** countryFrom 'job-description': the title or description text naming the place. */
  placeQuote: string | null;
  source: ClaimSource;
  /** Location kinds: the place as written. Language: the language. Else null. */
  detail: string | null;
}
export interface CheckJob {
  title: string;
  company: string;
  description: string;
}
export interface CheckQuestion {
  id: string;
  label: string;
  type?: string;
  options?: string[];
  helpText?: string;
  stepTitle?: string;
}
