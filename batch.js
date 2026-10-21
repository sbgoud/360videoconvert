#!/usr/bin/env node
/**
 * One-shot runner: convert YouTube links to 360 theatre videos and upload them
 * (private) to the channel, respecting a daily upload cap.
 *
 *   node batch.js <youtube-url> [more urls...]
 *   node batch.js                      (just process the queue, if the quota day reset)
 *
 * For each URL: normalize to the video id, skip ids already in processed.txt,
 * read the original title/description/tags with yt-dlp, convert with program.js,
 * upload private with the thumbnail. Over the daily cap, the converted video is
 * queued and uploaded on a later run after the YouTube quota day resets
 * (midnight America/Los_Angeles).
 *
 * Only a JSON summary is printed on stdout; progress goes to stderr.
 *
 * Env: STATE_DIR (default /workspace/360out), DAILY_LIMIT (default 5),
 *      PRIVACY (default private)
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Keep stdout clean for the final JSON: everything else goes to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

const { uploadVideo, buildMetadata } = require('./upload');

const STATE_DIR = process.env.STATE_DIR || '/workspace/360out';
const PROCESSED = path.join(STATE_DIR, 'processed.txt');
const QUEUE = path.join(STATE_DIR, 'queue.txt');
const DAILY = path.join(STATE_DIR, 'daily_uploads.json');
const LOCK = path.join(STATE_DIR, '.batch.lock');
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 5);
const PRIVACY = process.env.PRIVACY || 'private';
const QUOTA_TZ = 'America/Los_Angeles';
const USER_TZ = 'Asia/Dubai';
const EXTRA_TAGS = ['360theatreexperience', '360', 'theatre experience', '360 theatre'];

const log = (...a) => console.error('[batch]', ...a);

// ---------- time helpers (real time zones via Intl) ----------
function dateInTz(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function tzOffsetMinutes(date, tz) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date).find((x) => x.type === 'timeZoneName').value; // e.g. GMT-07:00
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}
/** Next midnight in `tz` after `now`, as a Date. */
function nextMidnight(now, tz) {
  const [y, mo, d] = dateInTz(now, tz).split('-').map(Number);
  let guess = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, mo - 1, d + 1) - tzOffsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess);
}
function formatInTz(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}

// ---------- state ----------
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; }
}
function processedIds() { return new Set(readLines(PROCESSED).map((l) => l.split(/\s+/)[0])); }
function markProcessed(id, uploadedId, title) {
  fs.appendFileSync(PROCESSED, `${id}\t${uploadedId}\t${new Date().toISOString()}\t${title.replace(/\s+/g, ' ')}\n`);
}
function readQueue() {
  return readLines(QUEUE).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function writeQueue(items) {
  const tmp = QUEUE + '.tmp';
  fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  fs.renameSync(tmp, QUEUE);
}
function readDaily() {
  try { return JSON.parse(fs.readFileSync(DAILY, 'utf8')); } catch { return {}; }
}
function writeDaily(state) {
  const tmp = DAILY + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DAILY);
}

// ---------- metadata ----------
function videoId(input) {
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    id = u.searchParams.get('v');
    if (!id) {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
function trimUtf16(str, max) {
  let out = '';
  for (const ch of String(str)) { if (out.length + ch.length > max) break; out += ch; }
  return out.trim();
}
function trimBytes(str, max) {
  if (Buffer.byteLength(str, 'utf8') <= max) return str;
  let out = '';
  let bytes = 0;
  for (const ch of str) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > max) break;
    out += ch; bytes += b;
  }
  return out;
}
function tagChars(tags) {
  return tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(tags.length - 1, 0);
}
function buildTags(original) {
  const clean = (t) => String(t).replace(/[<>,]/g, '').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const extras = [];
  for (const t of EXTRA_TAGS.map(clean)) if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); extras.push(t); }
  const tags = [];
  for (const t of (original || []).map(clean)) {
    if (!t || seen.has(t.toLowerCase())) continue;
    if (tagChars([...tags, t, ...extras]) > 500) continue; // keep extras guaranteed
    seen.add(t.toLowerCase());
    tags.push(t);
  }
  return [...tags, ...extras];
}
function fetchMeta(id) {
  const res = spawnSync('yt-dlp', ['--no-playlist', '--js-runtimes', `node:${process.execPath}`, '-J', '--skip-download',
    `https://www.youtube.com/watch?v=${id}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`yt-dlp not runnable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`yt-dlp metadata failed: ${(res.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  const info = JSON.parse(res.stdout);
  const title = trimUtf16(String(info.title || id).replace(/[<>]/g, ''), 100) || id;
  const description = trimBytes(String(info.description || '').replace(/[<>]/g, ''), 5000);
  return { title, description, tags: buildTags(info.tags) };
}

// ---------- conversion ----------
function convert(id, title) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'program.js'), `https://www.youtube.com/watch?v=${id}`, '--title', title],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; process.stderr.write(d); });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      const video = (out.match(/^\s*Video:\s+(.+\.mp4)\s*$/m) || [])[1];
      const thumb = (out.match(/^\s*Thumbnail:\s+(.+\.jpg)\s*$/m) || [])[1];
      if (code !== 0 || !video) {
        const msg = (err.match(/Error: [\s\S]*/) || [err.trim().split('\n').slice(-3).join(' ')])[0];
        return reject(new Error(`conversion failed: ${msg.trim().slice(0, 500)}`));
      }
      resolve({ file: video.trim(), thumbnail: thumb && thumb.trim() });
    });
  });
}

function isQuotaError(err) {
  const s = JSON.stringify((err && err.response && err.response.data) || '') + String(err && err.message);
  return /quotaExceeded|uploadLimitExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(s);
}
function errMsg(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  return (e && (e.message || e)) || (err && err.message) || String(err);
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) throw new Error(`another batch run is in progress (pid ${pid})`);
    fs.writeFileSync(LOCK, String(process.pid));
  }

  const now = new Date();
  const today = dateInTz(now, QUOTA_TZ);
  const reset = nextMidnight(now, QUOTA_TZ);
  const state = readDaily();
  const dayChanged = state.quotaDay !== today;
  if (dayChanged) {
    state.quotaDay = today;
    state.count = 0;
    state.uploads = [];
  }
  state.count = state.count || 0;
  state.uploads = state.uploads || [];
  const save = () => { state.nextResetUtc = reset.toISOString(); writeDaily(state); };
  save();

  const summary = {
    uploaded: [], queued: [], failed: [],
    limitReachedNow: false,
    resetTimeDubai: `${formatInTz(reset, USER_TZ)} Dubai`,
    resetJustHappenedWithQueuedUploads: false,
  };
  let limitHit = false;
  const remaining = () => DAILY_LIMIT - state.count;

  async function tryUpload(item) {
    if (remaining() <= 0) { limitHit = true; return 'limit'; }
    try {
      buildMetadata({ file: item.file, title: item.title, description: item.description, tags: item.tags, privacyStatus: PRIVACY });
      const vid = await uploadVideo({
        file: item.file, thumbnail: item.thumbnail, title: item.title,
        description: item.description, tags: item.tags, privacyStatus: PRIVACY,
      });
      state.count += 1;
      state.uploads.push({ sourceId: item.id, videoId: vid, title: item.title, at: new Date().toISOString() });
      save();
      markProcessed(item.id, vid, item.title);
      summary.uploaded.push({ title: item.title, videoId: vid, studioUrl: `https://studio.youtube.com/video/${vid}/edit` });
      if (remaining() <= 0) limitHit = true;
      return 'ok';
    } catch (err) {
      if (isQuotaError(err)) {
        log(`YouTube says quota/upload limit reached: ${errMsg(err)}`);
        state.count = Math.max(state.count, DAILY_LIMIT);
        save();
        limitHit = true;
        return 'limit';
      }
      throw err;
    }
  }

  // 1) Queued items first, when there is room today.
  let queue = readQueue();
  const done = processedIds();
  queue = queue.filter((q) => !done.has(q.id));
  const startQueueLen = queue.length;
  const stillQueued = [];
  for (const item of queue) {
    if (remaining() <= 0) { limitHit = true; stillQueued.push(item); continue; }
    if (!fs.existsSync(item.file)) {
      summary.failed.push({ url: item.url, error: `queued file missing: ${item.file}` });
      continue;
    }
    try {
      const r = await tryUpload(item);
      if (r === 'limit') stillQueued.push(item);
    } catch (err) {
      summary.failed.push({ url: item.url, error: String(errMsg(err)) });
      stillQueued.push(item); // keep it for a retry next run
    }
  }
  writeQueue(stillQueued);
  if (startQueueLen > 0 && summary.uploaded.length > 0 && state.resetQueueNotifiedDay !== today) {
    summary.resetJustHappenedWithQueuedUploads = true;
    state.resetQueueNotifiedDay = today;
    save();
  }

  // 2) New links.
  const seen = new Set();
  for (const url of process.argv.slice(2)) {
    const id = videoId(url);
    if (!id) { summary.failed.push({ url, error: 'not a YouTube video link' }); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    if (processedIds().has(id)) { log(`skip ${id}: already processed`); continue; }
    if (readQueue().some((q) => q.id === id)) { log(`skip ${id}: already queued`); summary.queued.push({ url, title: readQueue().find((q) => q.id === id).title, alreadyQueued: true }); continue; }
    try {
      log(`${id}: reading metadata`);
      const meta = fetchMeta(id);
      log(`${id}: converting "${meta.title}"`);
      const conv = await convert(id, meta.title);
      const item = { id, url, ...meta, ...conv, convertedAt: new Date().toISOString() };
      const r = await tryUpload(item);
      if (r === 'limit') {
        fs.appendFileSync(QUEUE, JSON.stringify(item) + '\n');
        summary.queued.push({ url, title: item.title, file: item.file });
      }
    } catch (err) {
      summary.failed.push({ url, error: String(errMsg(err)) });
    }
  }

  // 3) Limit flag: true only the first time per quota day.
  if (limitHit && state.limitNotifiedDay !== today) {
    summary.limitReachedNow = true;
    state.limitNotifiedDay = today;
  }
  save();
  summary.uploadsToday = state.count;
  summary.dailyLimit = DAILY_LIMIT;
  summary.queueLength = readQueue().length;
  return summary;
}

main()
  .then((summary) => { writeStdout(JSON.stringify(summary, null, 2) + '\n'); })
  .catch((err) => {
    writeStdout(JSON.stringify({ uploaded: [], queued: [], failed: [{ url: null, error: String(errMsg(err)) }],
      limitReachedNow: false, resetTimeDubai: null, resetJustHappenedWithQueuedUploads: false }, null, 2) + '\n');
    process.exitCode = 1;
  })
  .finally(() => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch {} });
