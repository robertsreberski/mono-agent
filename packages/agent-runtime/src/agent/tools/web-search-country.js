// @ts-check

// ISO 3166-1 alpha-2 assignment list. Kept local so validating a model tool call
// never needs network access or a new runtime dependency.
const ISO_COUNTRIES = new Set((
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
  "QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ " +
  "VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" "));

// DuckDuckGo's documented `kl` values are country-language region choices, not
// ISO tags. Some countries offer several choices; select a matching requested
// language when available and otherwise use the documented primary choice.
// Source: https://duckduckgo.com/duckduckgo-help-pages/settings/params
const DDG_REGIONS = new Map(Object.entries({
  AR: [["es", "ar-es"]], AU: [["en", "au-en"]], AT: [["de", "at-de"]],
  BE: [["fr", "be-fr"], ["nl", "be-nl"]], BR: [["pt", "br-pt"]],
  BG: [["bg", "bg-bg"]], CA: [["en", "ca-en"], ["fr", "ca-fr"]],
  CL: [["es", "cl-es"]], CN: [["zh", "cn-zh"]], CO: [["es", "co-es"]],
  HR: [["hr", "hr-hr"]], CZ: [["cs", "cz-cs"]], DK: [["da", "dk-da"]],
  EE: [["et", "ee-et"]], FI: [["fi", "fi-fi"]], FR: [["fr", "fr-fr"]],
  DE: [["de", "de-de"]], GR: [["el", "gr-el"]], HK: [["zh", "hk-tzh"]],
  HU: [["hu", "hu-hu"]], IN: [["en", "in-en"]],
  ID: [["id", "id-id"], ["en", "id-en"]], IE: [["en", "ie-en"]],
  IL: [["he", "il-he"]], IT: [["it", "it-it"]], JP: [["ja", "jp-jp"]],
  KR: [["ko", "kr-kr"]], LV: [["lv", "lv-lv"]], LT: [["lt", "lt-lt"]],
  MY: [["ms", "my-ms"], ["en", "my-en"]], MX: [["es", "mx-es"]],
  NL: [["nl", "nl-nl"]], NZ: [["en", "nz-en"]], NO: [["nb", "no-no"], ["no", "no-no"]],
  PE: [["es", "pe-es"]], PH: [["en", "ph-en"], ["tl", "ph-tl"]],
  PL: [["pl", "pl-pl"]], PT: [["pt", "pt-pt"]], RO: [["ro", "ro-ro"]],
  RU: [["ru", "ru-ru"]], SG: [["en", "sg-en"]], SK: [["sk", "sk-sk"]],
  SI: [["sl", "sl-sl"]], ZA: [["en", "za-en"]], ES: [["es", "es-es"]],
  SE: [["sv", "se-sv"]], CH: [["de", "ch-de"], ["fr", "ch-fr"], ["it", "ch-it"]],
  TW: [["zh", "tw-tzh"]], TH: [["th", "th-th"]], TR: [["tr", "tr-tr"]],
  UA: [["uk", "ua-uk"]], GB: [["en", "uk-en"]],
  US: [["en", "us-en"], ["es", "ue-es"]], VE: [["es", "ve-es"]],
  VN: [["vi", "vn-vi"]],
}));

/**
 * @param {unknown} value
 * @returns {{value?: string, error?: string}}
 */
export function normalizeSearchCountry(value) {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/u.test(value.trim())) {
    return { error: "WebSearch country must be a two-letter ISO 3166-1 alpha-2 code." };
  }
  const normalized = value.trim().toUpperCase();
  if (!ISO_COUNTRIES.has(normalized)) {
    return { error: `WebSearch country ${JSON.stringify(normalized)} is not an assigned ISO 3166-1 alpha-2 code.` };
  }
  return { value: normalized };
}

/**
 * Return DuckDuckGo's documented region token. Omitted country deliberately
 * selects DDG's documented no-region mode rather than an implicit US locale.
 *
 * @param {string | undefined} country
 * @param {string | undefined} language
 */
export function duckDuckGoRegion(country, language) {
  if (!country) return "wt-wt";
  const choices = DDG_REGIONS.get(country);
  if (!choices) return undefined;
  const requestedLanguage = typeof language === "string"
    ? language.trim().toLowerCase().split(/[-_]/u)[0]
    : "";
  return choices.find(([candidate]) => candidate === requestedLanguage)?.[1] ?? choices[0][1];
}

/** @param {string} backend */
export function unsupportedCountryFilter(backend) {
  return {
    code: "unsupported_country_filter",
    message: `${backend} does not support per-call country targeting; select a country-capable WebSearch provider.`,
    retryable: false,
    preflightSkipped: true,
  };
}
