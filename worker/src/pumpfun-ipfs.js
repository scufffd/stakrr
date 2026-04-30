// Upload token metadata to Pump.fun's IPFS endpoint, with Pinata fallback.
//
// The web app first tries POST https://pump.fun/api/ipfs from the *browser*
// (LaunchView): same multipart as below, but the request uses the user's IP and
// often succeeds when the worker would get HTTP 403. If that fails, the image
// is posted to this worker and we pin here (Pinata first when PINATA_JWT is set).
//
// Pump.fun's frontend uses POST https://pump.fun/api/ipfs with multipart/form-data:
//   file (Blob)         - the token image
//   name, symbol        - required
//   description, twitter, telegram, website - optional
//   showName=true       - show token name on cards
// Returns: { metadata, metadataUri }
//
// Pump.fun often returns 403 from datacenters/VPNs (blocked page) even with a
// browser User-Agent. When PINATA_JWT is set we try Pinata first, then pump.fun
// as backup. Without JWT, we try pump.fun then Pinata (which then errors with
// a clear "configure PINATA_JWT" message).
//
// Pinata upload URIs use IPFS_GATEWAY_BASE (default Pinata public gateway) so
// metadata resolves without relying on ipfs.io (often slow or blocked).

const PUMPFUN_IPFS_URL = 'https://pump.fun/api/ipfs';
const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Base URL for ipfs/{cid} paths we construct after Pinata pin (no trailing slash). */
function ipfsGatewayBase() {
  const raw = process.env.IPFS_GATEWAY_BASE || 'https://gateway.pinata.cloud/ipfs';
  return raw.replace(/\/$/, '');
}

function ipfsPublicUrl(cid) {
  return `${ipfsGatewayBase()}/${cid}`;
}

function fileNameForType(contentType) {
  if (!contentType) return 'logo.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'logo.jpg';
  if (contentType.includes('gif')) return 'logo.gif';
  if (contentType.includes('webp')) return 'logo.webp';
  return 'logo.png';
}

async function fetchImageBlob(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl, { headers: { 'user-agent': BROWSER_UA } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/png';
    return { buffer: Buffer.from(buf), contentType };
  } catch {
    return null;
  }
}

async function pumpfunUpload({
  name, symbol, description, twitter, telegram, website, fileBuffer, contentType,
}) {
  const form = new FormData();
  if (fileBuffer) {
    form.append('file', new Blob([fileBuffer], { type: contentType }), fileNameForType(contentType));
  }
  form.append('name', name);
  form.append('symbol', symbol);
  form.append('description', description || '');
  if (twitter) form.append('twitter', twitter);
  if (telegram) form.append('telegram', telegram);
  if (website) form.append('website', website);
  form.append('showName', 'true');

  const res = await fetch(PUMPFUN_IPFS_URL, {
    method: 'POST',
    headers: {
      'user-agent': BROWSER_UA,
      'origin': 'https://pump.fun',
      'referer': 'https://pump.fun/',
      'accept': 'application/json, text/plain, */*',
    },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`pump.fun /api/ipfs HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`pump.fun /api/ipfs non-JSON: ${text.slice(0, 200)}`);
  }
  const uri = json.metadataUri || json.metadata_uri || json.uri;
  if (!uri) throw new Error(`pump.fun /api/ipfs missing metadataUri: ${text.slice(0, 200)}`);
  const imageUri = json.metadata?.image || json.image || '';
  return { metadataUri: uri, imageUri, raw: json, source: 'pumpfun' };
}

async function pinataUpload({
  name, symbol, description, twitter, telegram, website, fileBuffer, contentType,
}) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error('PINATA_JWT not configured (fallback unavailable)');

  let imageUri = '';
  if (fileBuffer) {
    const fileForm = new FormData();
    fileForm.append('file', new Blob([fileBuffer], { type: contentType }), fileNameForType(contentType));
    const r = await fetch(PINATA_PIN_FILE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
      body: fileForm,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Pinata pinFile HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    imageUri = ipfsPublicUrl(j.IpfsHash);
  }

  const metadata = {
    name,
    symbol,
    description: description || '',
    image: imageUri || '',
    showName: true,
    createdOn: 'https://stakrr',
    twitter: twitter || '',
    telegram: telegram || '',
    website: website || '',
  };
  const r2 = await fetch(PINATA_PIN_JSON_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: metadata,
      pinataMetadata: { name: `${symbol}-stakrr-metadata` },
    }),
  });
  if (!r2.ok) {
    const t = await r2.text();
    throw new Error(`Pinata pinJSON HTTP ${r2.status}: ${t.slice(0, 200)}`);
  }
  const j2 = await r2.json();
  return {
    metadataUri: ipfsPublicUrl(j2.IpfsHash),
    imageUri,
    raw: { metadata, ipfsHash: j2.IpfsHash },
    source: 'pinata',
  };
}

/**
 * Upload metadata using either a pre-fetched file buffer (preferred — direct
 * upload from the browser) or by fetching `imageUrl` server-side.
 *
 * Order: Pinata first when PINATA_JWT is set (pump.fun /api/ipfs often 403s from
 * servers), otherwise pump.fun then Pinata.
 */
export async function uploadMetadata({
  name,
  symbol,
  description = '',
  twitter,
  telegram,
  website,
  imageUrl,
  fileBuffer,
  fileContentType,
}) {
  if (!name || !symbol) throw new Error('uploadMetadata: name + symbol required');

  let buffer = fileBuffer || null;
  let contentType = fileContentType || null;
  if (!buffer && imageUrl) {
    const fetched = await fetchImageBlob(imageUrl);
    if (fetched) {
      buffer = fetched.buffer;
      contentType = fetched.contentType;
    }
  }

  const args = {
    name, symbol, description, twitter, telegram, website,
    fileBuffer: buffer, contentType: contentType || 'image/png',
  };

  const errors = [];
  const hasPinataJwt = Boolean(process.env.PINATA_JWT?.trim());
  const attempts = hasPinataJwt
    ? [
        { tag: 'pinata', run: () => pinataUpload(args) },
        { tag: 'pumpfun', run: () => pumpfunUpload(args) },
      ]
    : [
        { tag: 'pumpfun', run: () => pumpfunUpload(args) },
        { tag: 'pinata', run: () => pinataUpload(args) },
      ];

  for (const { tag, run } of attempts) {
    try {
      return await run();
    } catch (e) {
      errors.push(`${tag}: ${e.message}`);
    }
  }
  const hint = hasPinataJwt
    ? ''
    : ' Set PINATA_JWT in the worker .env (Pinata API JWT) so uploads use Pinata; pump.fun often blocks server IPs.';
  throw new Error(`metadata upload failed: ${errors.join(' | ')}${hint}`);
}

// Backwards-compatible alias used by older imports.
export const uploadPumpFunMetadata = uploadMetadata;
