/** The 249 officially assigned ISO 3166-1 alpha-2 codes. */
const CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
`;

export const ISO_CODES: ReadonlySet<string> = new Set(
  CODES.split(/\s+/).filter(Boolean),
);

const EU = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
] as const;

/** Region names and aliases the model may use; expanded here, never by the model. */
export const REGIONS: Record<string, readonly string[]> = {
  EU,
  EEA: [...EU, 'IS', 'LI', 'NO'],
  SCHENGEN: [
    ...EU.filter((c) => c !== 'CY' && c !== 'IE'),
    'IS',
    'LI',
    'NO',
    'CH',
  ],
  UK: ['GB'],
};

export function isCountryToken(t: string): boolean {
  const u = t.trim().toUpperCase();
  return ISO_CODES.has(u) || Object.hasOwn(REGIONS, u);
}

/** Upper-cases, expands regions and the UK alias, keeps codes. Throws on an invalid token. */
export function expandCountries(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    const u = t.trim().toUpperCase();
    if (Object.hasOwn(REGIONS, u)) {
      for (const c of REGIONS[u] ?? []) out.add(c);
    } else if (ISO_CODES.has(u)) {
      out.add(u);
    } else {
      // The token is model output: never echoed.
      throw new Error('invalid country token');
    }
  }
  return out;
}
