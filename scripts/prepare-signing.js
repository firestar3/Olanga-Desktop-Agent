'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalizeThumbprint } = require('../desktop/signing-policy');
const expectedSigned = process.env.OLANGA_SIGNING_EXPECTED === 'true';
const thumbprint = normalizeThumbprint(process.env.OLANGA_SIGNING_PUBLISHER_THUMBPRINT || null);
if (thumbprint && !expectedSigned) throw new Error('A publisher thumbprint requires a signed build; configure both signing secrets.');
fs.writeFileSync(path.join(__dirname, '../desktop/trusted-publisher.json'), JSON.stringify({ schema: 1, thumbprint, required: !!thumbprint }, null, 2) + '\n');
console.log(thumbprint ? 'Prepared the exact publisher certificate policy for this signed build.' : 'No publisher certificate pin is configured.');
