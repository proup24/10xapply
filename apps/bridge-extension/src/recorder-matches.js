// The only pages the timing recorder ever runs on. Fixed here, never taken
// from the relay. Also the extension's host_permissions. LinkedIn is a
// single-page app, so the script goes on every LinkedIn page and records
// nothing outside /jobs/ (recorder-capture.js, recordable()).
export const RECORDER_MATCHES = [
  'https://www.linkedin.com/*',
  'https://deviceandbrowserinfo.com/are_you_a_bot_interactions*',
  'https://bot.incolumitas.com/*',
  'http://127.0.0.1/*',
];
