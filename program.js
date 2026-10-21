#!/usr/bin/env node
/**
 * 360videoconvert - put a normal video on a cinema screen inside a 360° theatre
 * image, give it a "hall" sound, and tag it as spherical so YouTube shows the
 * look-around 360 player.
 *
 * Usage:
 *   node program.js <youtube-url> [options]
 *   node program.js --file <local-video> [options]
 *
 * Options:
 *   --file <path>        Use a local video instead of downloading from YouTube
 *   --title <text>       Custom title: used as the YouTube upload title and (sanitized)
 *                        as the output file name. Default: the YouTube video's title
 *                        (or the local file name with --file)
 *   --section <range>    Only download part of the YouTube video, e.g. "0:30-1:10"
 *   --crf <n>            libx264 quality (default 18; lower = better/larger)
 *   --preset <name>      libx264 preset (default medium)
 *   --out <dir>          Output folder (default ./output)
 *   --keep-temp          Do not delete the per-run temp folder
 *   --upload             Upload the result to YouTube afterwards (see upload.js)
 *   --privacy <status>   private | unlisted | public (default private, for --upload)
 *   --description <text> Upload description (use \n for line breaks)
 *   --description-file <path>
 *                        Read a long / multi-line upload description from a file
 *   --tags <a,b,c>       Upload tags (comma separated)
 *   --category <id>      YouTube category id (default 24 = Entertainment)
 *   --dry-run            Validate everything and print the planned output files and
 *                        upload metadata, then stop (no download, encode or upload)
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const ASSETS = path.join(ROOT, 'assets');

// Creative layout — keep identical to the original script.
const THEATRE = { asset: 'image4k.png', w: 521, h: 257, x: 697, y: 890 };
const THUMB = { asset: 'background.png', w: 874, h: 462, x: 279, y: 147 };
const AUDIO_FILTER =
  "aecho=0.7:0.8:300:0.2,afftdn=nf=-20," +
  "firequalizer=gain_entry='entry(100,14);entry(200,7);entry(400,3.5)',aresample=48000";

// Fallback sources if an asset is missing from the repo.
const DRIVE_IDS = {
  'background.png': '1Vw-rE16jY5N5VakpAcGpV4o3DVig1Mg9',
  'image4k.png': '1uRnfHCvjsYVbUix1dQdZLL1Bjok8pXLp',
};

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.flv', '.3gp'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

function die(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { crf: 18, preset: 'medium', out: path.join(ROOT, 'output'), privacy: 'private', tags: [] };
  const valueFlags = ['file', 'title', 'section', 'crf', 'preset', 'out', 'privacy', 'description', 'description-file', 'tags', 'category'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--upload') opts.upload = true;
    else if (a === '--keep-temp') opts.keepTemp = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--') && valueFlags.includes(a.slice(2))) {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    } else if (a.startsWith('--')) die(`Unknown option ${a}`);
    else if (!opts.url) opts.url = a;
    else die(`Unexpected argument ${a}`);
  }
  if (typeof opts.tags === 'string') opts.tags = opts.tags.split(',').map((t) => t.trim()).filter(Boolean);
  opts.crf = Number(opts.crf);
  return opts;
}

function run(cmd, args, { capture = false, quiet = false } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`Could not run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = capture ? `\n${(res.stderr || '').trim().split('\n').slice(-15).join('\n')}` : '';
    throw new Error(`${cmd} exited with code ${res.status}${detail}`);
  }
  return capture ? res.stdout : '';
}

function hasTool(cmd) {
  const res = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  if (!res.error) return true;
  const alt = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !alt.error;
}

function preflight(needYtDlp) {
  const tools = [
    ['ffmpeg', 'https://ffmpeg.org/download.html  (Debian/Ubuntu: sudo apt install ffmpeg)'],
    ['ffprobe', 'ships with ffmpeg'],
    ['exiftool', 'https://exiftool.org  (Debian/Ubuntu: sudo apt install libimage-exiftool-perl)'],
  ];
  if (needYtDlp) tools.unshift(['yt-dlp', 'https://github.com/yt-dlp/yt-dlp#installation  (pip install -U "yt-dlp[default]")']);
  const missing = tools.filter(([t]) => !hasTool(t));
  if (missing.length) {
    die('Missing required tools on PATH:\n' + missing.map(([t, h]) => `  - ${t}: ${h}`).join('\n'));
  }
}

function isYouTubeUrl(u) {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) &&
      /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

function sanitize(name) {
  const s = String(name)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return s || 'video';
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
  return p;
}

function probe(file) {
  const out = run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { capture: true });
  return JSON.parse(out);
}

function isRealImage(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 1024) return false;
  const head = fs.readFileSync(file).subarray(0, 512).toString('latin1').toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) return false;
  const res = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return res.status === 0 && /^\d+,\d+/.test((res.stdout || '').trim());
}

function ensureAsset(name) {
  const file = path.join(ASSETS, name);
  if (isRealImage(file)) return file;
  console.log(`   ${name} missing from assets/, downloading from Google Drive...`);
  fs.mkdirSync(ASSETS, { recursive: true });
  const tmp = file + '.download';
  const url = `https://drive.usercontent.google.com/download?id=${DRIVE_IDS[name]}&export=download&confirm=t`;
  const res = spawnSync('curl', ['-sSL', '--fail', '-o', tmp, url], { stdio: 'inherit' });
  if (res.status !== 0 || !isRealImage(tmp)) {
    try { fs.unlinkSync(tmp); } catch {}
    die(`Could not get a valid image for assets/${name} (Google Drive returned something else). Put the image there manually.`);
  }
  fs.renameSync(tmp, file);
  return file;
}

function findFile(dir, prefix, exts) {
  const hit = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix + '.') && exts.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return hit[0];
}

function ytdlpBaseArgs() {
  // yt-dlp needs a JS runtime for YouTube; Node is always present here.
  return ['--no-playlist', '--js-runtimes', `node:${process.execPath}`];
}

function downloadFromYouTube(url, tmp, opts) {
  console.log('1. Reading video info...');
  const info = JSON.parse(run('yt-dlp', [...ytdlpBaseArgs(), '-J', '--skip-download', url], { capture: true }));
  const title = opts.title || info.title || info.id;

  console.log(`2. Downloading video + thumbnail: "${title}"`);
  const args = [
    ...ytdlpBaseArgs(),
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
    '--merge-output-format', 'mkv',
    '--write-thumbnail', '--convert-thumbnails', 'png',
    '-o', path.join(tmp, 'source.%(ext)s'),
    '-o', 'thumbnail:' + path.join(tmp, 'thumb.%(ext)s'),
  ];
  if (opts.section) args.push('--download-sections', `*${opts.section}`, '--force-keyframes-at-cuts');
  args.push(url);
  run('yt-dlp', args);

  const video = findFile(tmp, 'source', VIDEO_EXTS);
  if (!video) throw new Error(`yt-dlp finished but no video file was found in ${tmp}: ${fs.readdirSync(tmp).join(', ')}`);
  const thumb = findFile(tmp, 'thumb', IMAGE_EXTS);
  return { video, thumb, title, description: info.description || '' };
}

function grabFrameAsThumb(video, tmp, duration) {
  const out = path.join(tmp, 'thumb.png');
  const t = duration > 0 ? Math.min(duration * 0.1, 10) : 0;
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', video, '-frames:v', '1', out]);
  return out;
}

function frameRate(stream) {
  const [n, d] = String(stream.avg_frame_rate || stream.r_frame_rate || '25/1').split('/').map(Number);
  const fps = d ? n / d : n;
  return fps > 0 && fps <= 120 ? `${n}/${d || 1}` : '25';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.url && !opts.file)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ ?\* ?/gm, ''));
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.url && opts.file) die('Give either a YouTube URL or --file, not both.');
  if (opts.url && !isYouTubeUrl(opts.url)) die(`"${opts.url}" is not a YouTube URL (expected https://www.youtube.com/watch?v=... or https://youtu.be/...).`);
  if (opts.file && !fs.existsSync(opts.file)) die(`Input file not found: ${opts.file}`);
  if (!Number.isFinite(opts.crf) || opts.crf < 0 || opts.crf > 51) die('--crf must be between 0 and 51');
  if (!['private', 'unlisted', 'public'].includes(opts.privacy)) die('--privacy must be private, unlisted or public');

  preflight(Boolean(opts.url));

  // Read and validate upload metadata up front so a bad description/tag fails before the slow encode.
  const uploader = require('./upload');
  let description;
  try {
    description = uploader.readDescription({ description: opts.description, descriptionFile: opts.descriptionFile });
  } catch (err) { die(err.message); }
  // An explicit --title must fit YouTube's 100-char limit; a default title is trimmed to fit.
  const uploadMeta = (title, file) => ({
    file, title: opts.title ? opts.title : String(title).slice(0, 100), description, tags: opts.tags, privacyStatus: opts.privacy, categoryId: opts.category || '24',
  });

  if (opts.dryRun) {
    let title = opts.title;
    if (!title && opts.url) {
      try {
        const info = JSON.parse(run('yt-dlp', [...ytdlpBaseArgs(), '-J', '--skip-download', opts.url], { capture: true }));
        title = info.title || info.id;
      } catch (err) { die(err.message); }
    }
    if (!title) title = path.parse(opts.file).name;
    const base = sanitize(title);
    const outVideo = uniquePath(opts.out, base, '.mp4');
    console.log('DRY RUN - no download, encode or upload.');
    console.log(`  Source:      ${opts.url || path.resolve(opts.file)}${opts.section ? `  (section ${opts.section})` : ''}`);
    console.log(`  Encode:      libx264 crf ${opts.crf}, preset ${opts.preset}, 3840x2160 + AAC 192k`);
    console.log(`  Output mp4:  ${outVideo}`);
    console.log(`  Output jpg:  ${path.join(opts.out, path.parse(outVideo).name + '.jpg')}`);
    console.log(`  Upload:      ${opts.upload ? 'yes' : 'no (add --upload)'}`);
    try {
      await uploader.uploadVideo({ ...uploadMeta(title, outVideo), thumbnail: path.join(opts.out, path.parse(outVideo).name + '.jpg'), dryRun: true });
    } catch (err) { die(err.message); }
    return;
  }
  if (opts.upload && opts.title) {
    try { uploader.buildMetadata(uploadMeta(opts.title, 'x.mp4')); } catch (err) { die(err.message); }
  }

  console.log('0. Checking theatre assets...');
  const theatreImg = ensureAsset(THEATRE.asset);
  const thumbBg = ensureAsset(THUMB.asset);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '360vc-'));
  const cleanup = () => {
    if (opts.keepTemp) console.log(`   Temp files kept in ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    let src;
    if (opts.url) {
      src = downloadFromYouTube(opts.url, tmp, opts);
    } else {
      console.log('1-2. Using local file', opts.file);
      src = { video: path.resolve(opts.file), title: opts.title || path.parse(opts.file).name, description: '' };
    }

    const meta = probe(src.video);
    const vStream = meta.streams.find((s) => s.codec_type === 'video');
    const aStream = meta.streams.find((s) => s.codec_type === 'audio');
    if (!vStream) throw new Error('Input has no video stream.');
    const duration = Number(meta.format.duration) || 0;
    if (!src.thumb) src.thumb = grabFrameAsThumb(src.video, tmp, duration);

    fs.mkdirSync(opts.out, { recursive: true });
    const base = sanitize(src.title);
    const outVideo = uniquePath(opts.out, base, '.mp4');
    const outThumb = path.join(opts.out, path.parse(outVideo).name + '.jpg');

    console.log('3. Creating new thumbnail...');
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', thumbBg, '-i', src.thumb,
      '-filter_complex', `[1]scale=${THUMB.w}:${THUMB.h}[ovr];[0][ovr]overlay=${THUMB.x}:${THUMB.y}`,
      '-frames:v', '1', '-q:v', '2', outThumb,
    ]);

    console.log('4-7. Placing video on the theatre screen + enhancing audio (this is the slow part)...');
    const fps = frameRate(vStream);
    const filters = [`[1:v]scale=w=${THEATRE.w}:h=${THEATRE.h}[scaled]`,
      `[0:v][scaled]overlay=${THEATRE.x}:${THEATRE.y}:shortest=1,format=yuv420p[v]`];
    if (aStream) filters.push(`[1:a:0]${AUDIO_FILTER}[a]`);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-stats', '-y',
      '-loop', '1', '-framerate', fps, '-i', theatreImg,
      '-i', src.video,
      '-filter_complex', filters.join(';'),
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', opts.preset, '-crf', String(opts.crf),
      '-profile:v', 'high', '-r', fps,
    ];
    if (aStream) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    else console.warn('   (input has no audio track; output will be silent)');
    if (duration > 0) args.push('-t', String(duration));
    args.push('-movflags', '+faststart', outVideo);
    run('ffmpeg', args);

    console.log('8. Adding 360 metadata for YouTube...');
    run('exiftool', [
      '-overwrite_original',
      '-XMP-GSpherical:Spherical=true',
      '-XMP-GSpherical:Stitched=true',
      '-XMP-GSpherical:ProjectionType=equirectangular',
      '-XMP:StitchingSoftware=Spherical Metadata Tool',
      outVideo,
    ], { quiet: true });

    console.log('9. Cleaning up temp files...');
    cleanup();

    console.log('\nDone!');
    console.log(`   Video:     ${outVideo}`);
    console.log(`   Thumbnail: ${outThumb}`);

    if (opts.upload) {
      console.log('\n10. Uploading to YouTube...');
      await uploader.uploadVideo({ ...uploadMeta(src.title, outVideo), thumbnail: outThumb });
    }
  } catch (err) {
    cleanup();
    die(err && err.message ? err.message : String(err));
  }
}

main();
