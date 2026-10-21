# 360videoconvert

Turns a normal YouTube video into a **360° "theatre experience"** video: the clip plays on the cinema screen inside a 4K 360° theatre image, the audio gets a hall effect (echo, noise reduction, bass boost), and the file is tagged with spherical metadata so YouTube shows the look-around 360 player. It also makes a matching thumbnail, and can optionally upload the result to your channel with the YouTube Data API.

## Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) (keep it updated: `yt-dlp -U` or `pip install -U "yt-dlp[default]"`)
- ffmpeg + ffprobe (`sudo apt install ffmpeg`)
- exiftool (`sudo apt install libimage-exiftool-perl`, or `brew install exiftool`)

The script checks these are on your PATH before it starts and tells you which one is missing.

```bash
git clone https://github.com/sbgoud/360videoconvert
cd 360videoconvert
npm install          # only needed for uploading
```

The theatre image (`assets/image4k.png`, 3840x2160) and thumbnail background (`assets/background.png`, 1280x720) are in the repo, so nothing is downloaded from Google Drive at run time. If either file is missing, the script re-downloads it from Drive and checks that it is a real image.

## Convert a video

```bash
node program.js "https://www.youtube.com/watch?v=VIDEO_ID"
```

The results go into `output/`, named after the video title:

- `output/<title>.mp4`: 3840x2160 H.264 + AAC with 360 (equirectangular) metadata
- `output/<title>.jpg`: thumbnail with the original thumbnail placed on the background

Options:

| Option | What it does |
| --- | --- |
| `--file <path>` | Convert a local video instead of a YouTube link |
| `--title <text>` | Custom title. It is used as the YouTube title and, sanitized, as the output file name. Defaults to the video's own title (or the file name with `--file`) |
| `--section 0:30-1:10` | Only download part of the YouTube video |
| `--crf 18` | Video quality (lower is better and larger, default 18) |
| `--preset medium` | x264 speed/size trade-off (`veryfast` … `slow`) |
| `--out <dir>` | Output folder (default `output/`) |
| `--keep-temp` | Keep the per-run temp folder for debugging |
| `--upload` | Upload to YouTube after converting (see below) |
| `--privacy private` | `private` / `unlisted` / `public` for the upload |
| `--description <text>` | Upload description (`\n` = line break) |
| `--description-file <path>` | Read a long, multi-line description from a text file |
| `--tags a,b,c` | Upload tags, comma separated |
| `--category <id>` | YouTube category (default `24` Entertainment) |
| `--dry-run` | Check everything and print the planned files and upload metadata, then stop. Nothing is downloaded, encoded or uploaded |

Each run works in its own temp folder, which is deleted at the end, so you can run several videos one after another without overwriting anything.

## Upload to YouTube (optional)

Uploads use the official YouTube Data API v3 with OAuth.

1. In [Google Cloud Console](https://console.cloud.google.com/), signed in as the channel's Google account, in **one** project:
   - enable **YouTube Data API v3**
   - set up the **OAuth consent screen** (External) and add the channel account under **Audience → Test users**
   - create an OAuth client of type **Desktop app** and download its JSON
2. Save the JSON as `/workspace/360videoconvert-secrets/client_secret.json`, or point `CLIENT_SECRET_PATH` at it. The token is stored at `/workspace/360videoconvert-secrets/token.json` (override with `TOKEN_PATH`). **Never commit these files**; `.gitignore` excludes them.
3. Authorize once:

   ```bash
   node upload.js auth-url
   ```

   Open the printed link on any device, signed in as the channel account, and approve. Your browser then goes to `http://localhost/?code=...`. The page won't load, and that's expected. Copy that whole address and run:

   ```bash
   node upload.js auth 'http://localhost/?code=...'
   ```

4. Upload:

   ```bash
   # convert + upload in one go, with your own title/description
   node program.js "https://youtu.be/VIDEO_ID" --upload \
     --title "Movie Trailer | 360° Theatre Experience 🎧" \
     --description-file description.txt \
     --tags "360,theatre experience,dolby surround" \
     --privacy private

   # upload an mp4 you already converted
   node upload.js upload "output/My Video.mp4" \
     --title "My Video | 360° Theatre Experience" \
     --description "Use headphones 🎧\nDrag to look around" \
     --thumbnail "output/My Video.jpg" \
     --tags "360,theatre" --privacy private

   # preview exactly what would be sent, without uploading
   node upload.js upload "output/My Video.mp4" --title "..." --description-file description.txt --dry-run
   node program.js "https://youtu.be/VIDEO_ID" --upload --title "..." --dry-run
   ```

   `upload.js upload` options: `--title` (default: the mp4 file name), `--description` or `--description-file` (pick one), `--tags`, `--thumbnail` (default: the `.jpg` with the same name next to the mp4), `--privacy` (default `private`), `--category`, `--dry-run`.
   YouTube limits are checked before anything uploads, or before the slow encode when you use `program.js --upload`: title up to 100 characters, description up to 5000 bytes, tags up to 500 characters in total, and no `<` or `>`.

   The matching `.jpg` thumbnail is uploaded too. Custom thumbnails require a phone-verified channel (https://www.youtube.com/verify). If setting it fails, the video still uploads.

Notes:
- Until Google verifies your API project ("audit"), videos uploaded through the API are locked to **private**. Make them public in YouTube Studio, or apply for the audit.
- The default quota is 10,000 units/day, and each upload costs about 1,600, so you get about 6 uploads/day. You can request more in the same audit.

## Copyright

Re-uploading trailers and songs you don't own can get Content ID claims or copyright strikes. Use content you have the rights to.

Contact: shashank2bandari@gmail.com
