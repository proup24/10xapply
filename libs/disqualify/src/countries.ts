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

const codes = (list: string): string[] => list.split(/\s+/).filter(Boolean);

// UN M49 Europe (all four sub-regions), plus TR and CY, which M49 puts in
// Western Asia. XK (Kosovo) has no ISO code and is left out.
const EUROPE = codes(`
AL AD AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU
IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ
SK SM TR UA VA
`);

// UN M49 Africa (all five sub-regions), including the territories M49 lists.
const AFRICA = codes(`
AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE
KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST
SZ TD TG TN TZ UG YT ZA ZM ZW IO TF
`);

// World Bank Middle East and North Africa list; West Bank and Gaza is PS.
const MENA = codes(`
AE BH DJ DZ EG IL IQ IR JO KW LB LY MA MT OM PS QA SA SY TN YE
`);

// North America as used in job posts: the three NAFTA/USMCA countries.
const NORTH_AMERICA = ['US', 'CA', 'MX'];

// UN M49 Latin America and the Caribbean.
const LATAM = codes(`
AG AI AR AW BB BL BO BQ BR BS BV BZ CL CO CR CU CW DM DO EC FK GD GF GP
GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PR PY SR SV SX TC TT UY
VC VE VG VI
`);

// UN M49 Americas: Latin America and the Caribbean plus Northern America.
const AMERICAS = [...LATAM, 'BM', 'CA', 'GL', 'PM', 'US'];

// UN M49 Asia plus Oceania, without the Western Asia members already in
// MENA, and without CY and TR, which are in EUROPE.
const APAC = codes(`
AF AM AU AS AZ BD BN BT CC CK CN CX FJ FM GE GU HK HM ID IN JP KG KH KI
KP KR KZ LA LK MH MM MN MO MP MV MY NC NF NP NR NU NZ PF PG PH PK PN PW
SB SG TH TJ TK TL TM TO TV TW UM UZ VN VU WF WS
`);

/**
 * Region names and aliases the model may use; expanded here, never by the
 * model. Keys are upper case; `_` stands for a space.
 */
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
  EUROPE,
  // EUROPE, MENA and AFRICA together.
  EMEA: [...new Set([...EUROPE, ...MENA, ...AFRICA])],
  MENA,
  AFRICA,
  NORTH_AMERICA,
  LATAM,
  AMERICAS,
  APAC,
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
