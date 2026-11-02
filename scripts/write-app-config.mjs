// Writes optional anonymous analytics configuration into the app bundle.
// Packaged apps ignore shell overrides, so their analytics destination is fixed at build time.
// For local builds, values may also come from openclean.local.json (git-ignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const local = existsSync('openclean.local.json') ? JSON.parse(readFileSync('openclean.local.json', 'utf8')) : {};
const read = (name, key) => process.env[name]?.trim() || (typeof local[key] === 'string' ? local[key].trim() : '');
const config = {
  // GA4 Measurement Protocol, for counting installs and active users. The API secret only
  // allows sending events to this property; it cannot read any data.
  gaMeasurementId: read('OPENCLEAN_GA_MEASUREMENT_ID', 'gaMeasurementId'),
  gaApiSecret: read('OPENCLEAN_GA_API_SECRET', 'gaApiSecret')
};

if (config.gaMeasurementId && !/^G-[A-Z0-9]+$/.test(config.gaMeasurementId)) throw new Error('OPENCLEAN_GA_MEASUREMENT_ID must look like G-XXXXXXXXXX.');

mkdirSync('dist-electron', { recursive: true });
writeFileSync('dist-electron/app-config.json', `${JSON.stringify(config, null, 2)}\n`);
const analytics = config.gaMeasurementId && config.gaApiSecret;
console.log(`App config written: usage analytics ${analytics ? 'enabled' : 'disabled'}.`);
