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
 *   node upload.js upload <video.mp4> [options]
 *       --title <text>            YouTube title (default: the mp4 file name)
 *       --description <text>      Description (use \n for line breaks)
 *       --description-file <path> Read a long / multi-line description from a file
 *       --tags <a,b,c>            Comma-separated tags
 *       --thumbnail <img.jpg>     Custom thumbnail (default: same name .jpg next to the mp4)
 *       --privacy <status>        private | unlisted | public (default private)
 *       --category <id>           YouTube category id (default 24 = Entertainment)
 *       --dry-run                 Print what would be uploaded, upload nothing
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

const PRIVACY = ['private', 'unlisted', 'public'];

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function readDescription({ description, descriptionFile }) {
  if (description !== undefined && descriptionFile !== undefined) {
    throw new Error('Use either --description or --description-file, not both.');
  }
  if (descriptionFile !== undefined) {
    if (!fs.existsSync(descriptionFile)) throw new Error(`Description file not found: ${descriptionFile}`);
    return fs.readFileSync(descriptionFile, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  }
  // Allow "\n" typed on the command line to mean a line break.
  return description === undefined ? '' : String(description).replace(/\\n/g, '\n');
}

/** Build and validate the YouTube snippet/status exactly as it will be sent. */
function buildMetadata({ file, title, description = '', tags = [], privacyStatus = 'private', categoryId = '24' }) {
  const finalTitle = String(title && String(title).trim() ? title : path.parse(file).name.slice(0, 100)).replace(/[<>]/g, '').trim();
  if (!finalTitle) throw new Error('Title is empty.');
  if (finalTitle.length > 100) throw new Error(`Title is ${finalTitle.length} characters; YouTube allows 100.`);
  const desc = String(description).replace(/[<>]/g, '');
  if (Buffer.byteLength(desc, 'utf8') > 5000) throw new Error(`Description is ${Buffer.byteLength(desc, 'utf8')} bytes; YouTube allows 5000.`);
  const tagList = parseTags(tags).map((t) => t.replace(/[<>,]/g, ''));
  const tagChars = tagList.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(tagList.length - 1, 0);
  if (tagChars > 500) throw new Error(`Tags total ${tagChars} characters; YouTube allows 500.`);
  if (!PRIVACY.includes(privacyStatus)) throw new Error('--privacy must be private, unlisted or public');
  return {
    snippet: { title: finalTitle, description: desc, tags: tagList, categoryId: String(categoryId) },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  };
}

function printDryRun({ file, thumbnail }, meta) {
  const size = fs.existsSync(file) ? `${(fs.statSync(file).size / 1e6).toFixed(1)} MB` : '(file not created yet)';
  console.log('DRY RUN - nothing will be uploaded.');
  console.log(`  File:        ${file}  ${size}`);
  console.log(`  Thumbnail:   ${thumbnail || '(none)'}`);
  console.log(`  Title:       ${meta.snippet.title}`);
  console.log(`  Privacy:     ${meta.status.privacyStatus}`);
  console.log(`  Category:    ${meta.snippet.categoryId}`);
  console.log(`  Tags:        ${meta.snippet.tags.length ? meta.snippet.tags.join(', ') : '(none)'}`);
  console.log(`  Description (${meta.snippet.description.length} chars):`);
  console.log(meta.snippet.description ? meta.snippet.description.split('\n').map((l) => '    | ' + l).join('\n') : '    (empty)');
}

async function uploadVideo({ file, thumbnail, title, description = '', tags = [], privacyStatus = 'private', categoryId = '24', dryRun = false }) {
  const meta = buildMetadata({ file, title, description, tags, privacyStatus, categoryId });
  if (dryRun) { printDryRun({ file, thumbnail }, meta); return null; }
  if (!file || !fs.existsSync(file)) throw new Error(`Video not found: ${file}`);
  const google = loadGoogle();
  const auth = authorizedClient();
  const youtube = google.youtube({ version: 'v3', auth });
  const safeTitle = meta.snippet.title;
  const size = fs.statSync(file).size;

  console.log(`Uploading "${safeTitle}" (${(size / 1e6).toFixed(1)} MB, ${privacyStatus})...`);
  let last = -1;
  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      notifySubscribers: privacyStatus === 'public',
      requestBody: {
        snippet: meta.snippet,
        status: meta.status,
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
  const BOOL = ['dry-run'];
  const VALUE = ['title', 'description', 'description-file', 'tags', 'thumbnail', 'privacy', 'category'];
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (BOOL.includes(name)) out[name] = true;
    else if (VALUE.includes(name)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      out[name] = argv[++i];
    } else throw new Error(`Unknown option ${a}`);
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
      if (!f._[0]) throw new Error('Usage: node upload.js upload <video.mp4> [--title ...] [--description ... | --description-file ...] [--tags a,b] [--thumbnail img.jpg] [--privacy private] [--dry-run]');
      if (f._.length > 1) throw new Error(`Unexpected argument ${f._[1]} (quote titles/descriptions that contain spaces)`);
      const file = f._[0];
      if (!fs.existsSync(file)) throw new Error(`Video not found: ${file}`);
      if (f.thumbnail && !fs.existsSync(f.thumbnail)) throw new Error(`Thumbnail not found: ${f.thumbnail}`);
      const guessThumb = file.replace(/\.mp4$/i, '.jpg');
      await uploadVideo({
        file,
        thumbnail: f.thumbnail || (guessThumb !== file && fs.existsSync(guessThumb) ? guessThumb : undefined),
        title: f.title,
        description: readDescription({ description: f.description, descriptionFile: f['description-file'] }),
        tags: f.tags,
        privacyStatus: f.privacy || 'private',
        categoryId: f.category || '24',
        dryRun: Boolean(f['dry-run']),
      });
      break;
    }
    case 'help': case '--help': case '-h':
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ ?\* ?/gm, ''));
      process.exit(!cmd || ['help', '--help', '-h'].includes(cmd) ? 0 : 1);
  }
}

module.exports = { uploadVideo, buildMetadata, readDescription, parseTags, authUrl, finishAuth };

if (require.main === module) {
  cli().catch((err) => {
    console.error(`\nError: ${apiError(err)}`);
    process.exit(1);
  });
}
