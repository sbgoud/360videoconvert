#!/usr/bin/env node
/**
 * YouTube upload via the official YouTube Data API v3 (OAuth installed-app flow).
 *
 * Commands:
 *   node upload.js auth-url                 Print the Google approval link
 *   node upload.js auth <redirected-url|code>
 *                                           Finish approval: paste the full
 *                                           http://localhost/?code=... URL your
 *                                           browser landed on (or just the code)
 *   node upload.js upload <video.mp4> [--thumbnail img.jpg] [--title t]
 *                 [--description d] [--tags a,b,c] [--privacy private|unlisted|public]
 *                 [--category 24]
 *   node upload.js status                   Check whether a token is saved
 *
 * Files (never commit these):
 *   CLIENT_SECRET_PATH  default /workspace/360videoconvert-secrets/client_secret.json
 *   TOKEN_PATH          default /workspace/360videoconvert-secrets/token.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SECRETS_DIR = '/workspace/360videoconvert-secrets';
const CLIENT_SECRET_PATH = process.env.CLIENT_SECRET_PATH || path.join(SECRETS_DIR, 'client_secret.json');
const TOKEN_PATH = process.env.TOKEN_PATH || path.join(SECRETS_DIR, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const REDIRECT_URI = 'http://localhost';

function loadGoogle() {
  try {
    return require('googleapis').google;
  } catch {
    throw new Error('The "googleapis" package is not installed. Run: npm install');
  }
}

function makeClient() {
  if (!fs.existsSync(CLIENT_SECRET_PATH)) {
    throw new Error(`OAuth client file not found at ${CLIENT_SECRET_PATH}. Download it from Google Cloud Console (Clients > Desktop app > Download JSON) or set CLIENT_SECRET_PATH.`);
  }
  const raw = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf8'));
  const cfg = raw.installed || raw.web;
  if (!cfg || !cfg.client_id || !cfg.client_secret) throw new Error(`${CLIENT_SECRET_PATH} is not an OAuth client JSON.`);
  const google = loadGoogle();
  const client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, REDIRECT_URI);
  client.on('tokens', (tokens) => {
    // Keep the refresh token when Google only sends a new access token.
    const prev = readToken() || {};
    saveToken({ ...prev, ...tokens });
  });
  return client;
}

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

function saveToken(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
}

function authUrl() {
  return makeClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

function extractCode(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste the full redirected URL (http://localhost/?code=...) or the code.');
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    if (u.searchParams.get('error')) throw new Error(`Google returned an error: ${u.searchParams.get('error')}`);
    const code = u.searchParams.get('code');
    if (!code) throw new Error('That URL has no ?code= in it.');
    return code;
  }
  return decodeURIComponent(s);
}

async function finishAuth(input) {
  const client = makeClient();
  const { tokens } = await client.getToken(extractCode(input));
  saveToken(tokens);
  if (!tokens.refresh_token) console.warn('Warning: no refresh token returned; re-run auth-url (it forces consent) if uploads stop working.');
  console.log(`Authorized. Token saved to ${TOKEN_PATH}`);
}

function authorizedClient() {
  const client = makeClient();
  const token = readToken();
  if (!token) throw new Error(`Not authorized yet. Run "node upload.js auth-url", approve, then "node upload.js auth '<redirected-url>'".`);
  client.setCredentials(token);
  return client;
}

async function uploadVideo({ file, thumbnail, title, description = '', tags = [], privacyStatus = 'private', categoryId = '24' }) {
  if (!file || !fs.existsSync(file)) throw new Error(`Video not found: ${file}`);
  const google = loadGoogle();
  const auth = authorizedClient();
  const youtube = google.youtube({ version: 'v3', auth });
  const size = fs.statSync(file).size;
  const safeTitle = String(title || path.parse(file).name).replace(/[<>]/g, '').slice(0, 100);

  console.log(`Uploading "${safeTitle}" (${(size / 1e6).toFixed(1)} MB, ${privacyStatus})...`);
  let last = -1;
  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      notifySubscribers: privacyStatus === 'public',
      requestBody: {
        snippet: { title: safeTitle, description: String(description).slice(0, 5000), tags, categoryId: String(categoryId) },
        status: { privacyStatus, selfDeclaredMadeForKids: false },
      },
      media: { body: fs.createReadStream(file) },
    },
    {
      onUploadProgress: (evt) => {
        const pct = Math.floor((evt.bytesRead / size) * 100);
        if (pct !== last && pct % 5 === 0) { last = pct; process.stdout.write(`\r   ${pct}%`); }
      },
    },
  );
  process.stdout.write('\n');
  const id = res.data.id;
  console.log(`Uploaded: https://youtu.be/${id}  (status: ${res.data.status && res.data.status.privacyStatus})`);

  if (thumbnail && fs.existsSync(thumbnail)) {
    try {
      await youtube.thumbnails.set({ videoId: id, media: { body: fs.createReadStream(thumbnail) } });
      console.log('Custom thumbnail set.');
    } catch (err) {
      console.warn(`Could not set custom thumbnail (${apiError(err)}). The channel may need phone verification at https://www.youtube.com/verify — set it in YouTube Studio instead.`);
    }
  }
  return id;
}

function apiError(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  if (e && e.message) return e.message;
  return err && err.message ? err.message : String(err);
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'auth-url':
      console.log('Open this link signed in as the channel account, approve, and copy the');
      console.log('http://localhost/?code=... address your browser ends up on (the page itself will not load — that is expected):\n');
      console.log(authUrl());
      console.log(`\nThen run:  node upload.js auth '<that full URL>'`);
      break;
    case 'auth':
      await finishAuth(rest.join(' '));
      break;
    case 'status':
      console.log(readToken() ? `Authorized (token at ${TOKEN_PATH}).` : 'Not authorized yet.');
      break;
    case 'upload': {
      const f = parseFlags(rest);
      if (!f._[0]) throw new Error('Usage: node upload.js upload <video.mp4> [--thumbnail img.jpg] [--title ...]');
      const privacy = f.privacy || 'private';
      if (!['private', 'unlisted', 'public'].includes(privacy)) throw new Error('--privacy must be private, unlisted or public');
      const guessThumb = f._[0].replace(/\.mp4$/i, '.jpg');
      await uploadVideo({
        file: f._[0],
        thumbnail: f.thumbnail || (fs.existsSync(guessThumb) ? guessThumb : undefined),
        title: f.title,
        description: f.description || '',
        tags: (f.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
        privacyStatus: privacy,
        categoryId: f.category || '24',
      });
      break;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ ?\* ?/gm, ''));
      process.exit(cmd ? 1 : 0);
  }
}

module.exports = { uploadVideo, authUrl, finishAuth };

if (require.main === module) {
  cli().catch((err) => {
    console.error(`\nError: ${apiError(err)}`);
    process.exit(1);
  });
}
