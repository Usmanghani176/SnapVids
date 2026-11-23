const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const ffmpegPath = require('ffmpeg-static');
const btch = require('btch-downloader');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Writable directory setup (/tmp on Vercel serverless, project root locally)
const BASE_WRITABLE_DIR = IS_VERCEL ? '/tmp' : __dirname;
const BIN_DIR = path.join(BASE_WRITABLE_DIR, 'bin');
const YT_DLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const TEMP_DIR = path.join(BASE_WRITABLE_DIR, 'temp_downloads');

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let isBinaryReady = IS_VERCEL;
let binaryDownloadPromise = null;

// Active download jobs & metadata cache
const downloadJobs = new Map();
const infoCache = new Map();
const INFO_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Helper: Extract and normalize YouTube URL from raw input or share text
function normalizeYouTubeUrl(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let str = rawInput.trim();

  // Extract URL if embedded in share text (e.g. "Watch this: https://youtu.be/...")
  const urlMatch = str.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch) {
    str = urlMatch[0];
  } else if (/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(str)) {
    str = 'https://' + str;
  }

  try {
    const parsed = new URL(str);
    const host = parsed.hostname.toLowerCase();
    const isYt =
      host === 'www.youtube.com' ||
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtu.be';

    if (!isYt) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// Helper: Sanitize filename for safe OS & HTTP header usage
function sanitizeFilename(name) {
  return (name || 'youtube_video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'youtube_video';
}

// Periodic cleanup of old temp files and finished jobs (every 10 minutes)
function cleanupTempFiles() {
  const now = Date.now();
  const maxAgeMs = 30 * 60 * 1000; // 30 minutes

  for (const [jobId, job] of downloadJobs.entries()) {
    if (now - job.createdAt > maxAgeMs) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        try { fs.unlinkSync(job.filePath); } catch {}
      }
      downloadJobs.delete(jobId);
    }
  }

  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const fullPath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
        }
      } catch {}
    }
  } catch {}
}
setInterval(cleanupTempFiles, 10 * 60 * 1000).unref();

// Atomic binary downloader with executable permissions
function downloadFileAtomic(url, dest) {
  const tempDest = `${dest}.downloading_${Date.now()}`;
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download binary (HTTP ${res.statusCode})`));
        }
        const file = fs.createWriteStream(tempDest, { mode: 0o755 });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              if (process.platform !== 'win32') fs.chmodSync(tempDest, 0o755);
              if (fs.existsSync(dest)) {
                try { fs.unlinkSync(dest); } catch {}
              }
              fs.renameSync(tempDest, dest);
              if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });
      }).on('error', (err) => {
        if (fs.existsSync(tempDest)) {
          try { fs.unlinkSync(tempDest); } catch {}
        }
        reject(err);
      });
    };
    request(url);
  });
}

// Ensure yt-dlp binary is present and executable
async function ensureYtDlp() {
  if (fs.existsSync(YT_DLP_PATH)) {
    try {
      const stats = fs.statSync(YT_DLP_PATH);
      if (stats.size > 5000000) {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(YT_DLP_PATH, 0o755); } catch {}
        }
        if (ffmpegPath && process.platform !== 'win32' && fs.existsSync(ffmpegPath)) {
          try { fs.chmodSync(ffmpegPath, 0o755); } catch {}
        }
        isBinaryReady = true;
        return YT_DLP_PATH;
      }
    } catch {}
  }

  if (binaryDownloadPromise) return binaryDownloadPromise;

  const downloadUrl = process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

  console.log('Downloading yt-dlp engine for YouTube downloads...');
  binaryDownloadPromise = downloadFileAtomic(downloadUrl, YT_DLP_PATH)
    .then(() => {
      console.log('yt-dlp engine downloaded successfully!');
      isBinaryReady = true;
      binaryDownloadPromise = null;
      return YT_DLP_PATH;
    })
    .catch((err) => {
      binaryDownloadPromise = null;
      console.error('Error downloading yt-dlp:', err);
      throw err;
    });

  return binaryDownloadPromise;
}

if (!IS_VERCEL) {
  ensureYtDlp().catch(() => {});
}

// Parse query parameter from media stream URLs
function parseQueryParam(urlStr, paramName) {
  try {
    const decoded = decodeURIComponent(urlStr);
    const match = decoded.match(new RegExp(`[?&]${paramName}=([0-9.]+)`));
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

// Cloud fallback extractor for YouTube (generates full quality options with sizes)
async function fetchCloudYouTubeInfo(url) {
  const yt = await btch.youtube(url);
  if (!yt || (!yt.mp4 && !yt.mp3)) {
    throw new Error('Could not extract YouTube streams from cloud extractor.');
  }

  const rawDur = parseQueryParam(yt.mp4 || yt.mp3 || '', 'dur');
  const dur = rawDur ? parseFloat(rawDur) : 300;

  const aSize128 = Math.round((128 * 1000 / 8) * dur);
  const aSize48 = Math.round((48 * 1000 / 8) * dur);
  const mp3Size = Math.round((140 * 1000 / 8) * dur);

  const bitrates = [
    { h: 1080, kbps: 2350, tag: 'FHD', badge: 'Needs processing' },
    { h: 720,  kbps: 850,  tag: 'HD',  badge: 'HD' },
    { h: 480,  kbps: 450,  tag: 'SD',  badge: 'Needs processing' },
    { h: 360,  kbps: 280,  tag: 'SD',  badge: 'SD' },
    { h: 240,  kbps: 150,  tag: 'SD',  badge: 'Needs processing' },
    { h: 144,  kbps: 70,   tag: 'SD',  badge: 'Needs processing' }
  ];

  const options = [];
  for (const b of bitrates) {
    const vSize = Math.round((b.kbps * 1000 / 8) * dur);
    options.push({
      id: `height_${b.h}`,
      group: 'video',
      label: `${b.h}p · MP4`,
      quality: `${b.h}p`,
      resolutionTag: b.tag,
      ext: 'mp4',
      type: 'video',
      filesize: vSize + aSize128,
      badge: b.badge,
      directUrl: (b.h === 360 || b.h === 720) ? yt.mp4 : null
    });
  }

  options.push({
    id: 'audio_m4a_128',
    group: 'audio',
    label: 'M4A · 128 kbps',
    quality: '128 kbps',
    resolutionTag: 'M4A',
    ext: 'm4a',
    type: 'audio',
    filesize: aSize128,
    badge: 'Audio',
    directUrl: yt.mp3 || null
  });

  options.push({
    id: 'audio_m4a_48',
    group: 'audio',
    label: 'M4A · 48 kbps',
    quality: '48 kbps',
    resolutionTag: 'M4A',
    ext: 'm4a',
    type: 'audio',
    filesize: aSize48,
    badge: 'Audio',
    directUrl: yt.mp3 || null
  });

  options.push({
    id: 'best_audio',
    group: 'audio',
    label: 'MP3 · VBR',
    quality: 'VBR',
    resolutionTag: 'MP3',
    ext: 'mp3',
    type: 'audio',
    filesize: mp3Size,
    badge: 'Audio',
    directUrl: null
  });

  return {
    title: yt.title || 'YouTube Video',
    uploader: yt.author || 'YouTube Channel',
    channel: yt.author || 'YouTube Channel',
    description: yt.description || '',
    duration: dur,
    duration_string: '',
    thumbnail: yt.thumbnail || '',
    webpage_url: url,
    platform: 'youtube',
    extractor: 'YouTube',
    view_count: null,
    like_count: null,
    comment_count: null,
    isServerless: true,
    options
  };
}

// Run yt-dlp to inspect all available video and audio streams
function runYtDlpJson(url) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureYtDlp();
    } catch {
      return reject(new Error('Downloader engine is initializing. Please try again in a moment.'));
    }

    const args = [
      '--js-runtimes', 'node',
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      '--geo-bypass',
      url
    ];

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      args.unshift('--ffmpeg-location', ffmpegPath);
    }

    const proc = spawn(YT_DLP_PATH, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || 'Could not fetch YouTube video details. Make sure the video is public and valid.'));
      }
      try {
        const info = JSON.parse(stdout);
        if (!info || typeof info !== 'object') {
          return reject(new Error('Invalid YouTube video information received.'));
        }
        resolve(info);
      } catch {
        reject(new Error('Failed to parse YouTube video information.'));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

// Build yt-dlp format selector and CLI arguments for a given format ID
function buildYtDlpDownloadArgs({ url, format, type, tempOutputTemplate }) {
  const isMp3Conversion = format === 'best_audio';
  const isAudio = type === 'audio' || isMp3Conversion || format === 'audio_m4a_128' || format === 'audio_m4a_48';

  let formatSelector = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b';
  if (format === 'audio_m4a_128') {
    formatSelector = 'ba[format_id=140]/ba[ext=m4a]/ba/b';
  } else if (format === 'audio_m4a_48') {
    formatSelector = 'ba[format_id=249]/ba[format_id=599]/ba[abr<=64]/ba/b';
  } else if (isAudio) {
    formatSelector = 'ba[ext=m4a]/ba/b';
  } else if (format && format.startsWith('height_')) {
    const h = parseInt(format.replace('height_', ''), 10);
    formatSelector = `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
  } else if (format && format !== 'best_mp4') {
    formatSelector = `${format}+ba[ext=m4a]/${format}+ba/${format}/bv*+ba/b`;
  }

  const args = [
    '--js-runtimes', 'node',
    '--newline',
    '--progress',
    '-f', formatSelector,
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '-o', tempOutputTemplate
  ];

  const hasFfmpeg = ffmpegPath && fs.existsSync(ffmpegPath);
  if (hasFfmpeg) {
    args.push('--ffmpeg-location', ffmpegPath);
    if (isMp3Conversion) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (!isAudio) {
      args.push('--merge-output-format', 'mp4');
    }
  }

  args.push(url);
  const expectedExt = isMp3Conversion && hasFfmpeg ? 'mp3' : (isAudio ? 'm4a' : 'mp4');

  return { args, isAudio, expectedExt };
}

// Engine status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    ready: isBinaryReady,
    downloadingEngine: !!binaryDownloadPromise
  });
});

// Thumbnail proxy to avoid CORS / hotlink blocks
app.get('/api/thumbnail', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing image URL');

  try {
    const parsed = new URL(imageUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    client.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': parsed.origin
      }
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        return res.redirect(`/api/thumbnail?url=${encodeURIComponent(proxyRes.headers.location)}`);
      }
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      proxyRes.pipe(res);
    }).on('error', () => {
      res.status(500).send('Failed to load thumbnail');
    });
  } catch {
    res.status(400).send('Invalid URL');
  }
});

// Proxy download for direct CDN URLs (used on cloud / serverless)
app.get('/api/proxy-download', (req, res) => {
  const { directUrl, title, ext } = req.query;
  if (!directUrl) return res.status(400).send('Missing directUrl');

  const cleanTitle = sanitizeFilename(title || 'youtube_video');
  const asciiTitle = cleanTitle.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim() || 'youtube_video';
  const fileExt = (ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const encodedFullFile = encodeURIComponent(`${cleanTitle}.${fileExt}`);

  const streamUrl = (targetUrl, redirectCount = 0) => {
    if (redirectCount > 8) {
      if (!res.headersSent) res.status(502).send('Too many redirects from media source.');
      return;
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      if (!res.headersSent) res.status(400).send('Invalid media stream URL.');
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': parsed.origin + '/'
      },
      rejectUnauthorized: false
    };

    client.get(targetUrl, reqOpts, (upRes) => {
      if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
        upRes.resume();
        const nextUrl = new URL(upRes.headers.location, targetUrl).href;
        return streamUrl(nextUrl, redirectCount + 1);
      }

      if (upRes.statusCode && upRes.statusCode >= 400) {
        upRes.resume();
        if (!res.headersSent) {
          res.status(502).send(`Upstream server returned HTTP ${upRes.statusCode}`);
        }
        return;
      }

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiTitle}.${fileExt}"; filename*=UTF-8''${encodedFullFile}`
      );
      res.setHeader('Content-Type', upRes.headers['content-type'] || 'application/octet-stream');
      if (upRes.headers['content-length']) {
        res.setHeader('Content-Length', upRes.headers['content-length']);
      }
      upRes.pipe(res);
    }).on('error', (err) => {
      console.error('Proxy stream error:', err.message);
      if (!res.headersSent) res.status(500).send('Failed to proxy media stream.');
    });
  };

  streamUrl(directUrl);
});

// Fetch YouTube video metadata & available Video / Audio quality options
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  const normalizedUrl = normalizeYouTubeUrl(url);

  if (!normalizedUrl) {
    return res.status(400).json({
      error: 'Please enter a valid YouTube link (e.g., https://youtu.be/... or https://youtube.com/watch?v=...).'
    });
  }

  // Check in-memory cache first for instant response
  const cached = infoCache.get(normalizedUrl);
  if (cached && Date.now() - cached.timestamp < INFO_CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const info = await runYtDlpJson(normalizedUrl);
    const rawFormats = Array.isArray(info.formats) ? info.formats : [];
    const duration = info.duration || 0;

    // Audio stream size (Format 140 / 128 kbps m4a)
    const m4a140 = rawFormats.find(f => f.format_id === '140') ||
                   rawFormats.find(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.ext === 'm4a') ||
                   rawFormats.find(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));

    let audioBytes140 = m4a140 ? (m4a140.filesize || m4a140.filesize_approx) : 0;
    if (!audioBytes140 && duration) {
      audioBytes140 = Math.round((128 * 1000 / 8) * duration);
    }

    // Low bitrate audio (Format 249 / 48 kbps)
    const m4a48 = rawFormats.find(f => f.format_id === '249' || f.format_id === '599' || (f.acodec && f.abr && f.abr <= 64));
    let audioBytes48 = m4a48 ? (m4a48.filesize || m4a48.filesize_approx) : 0;
    if (!audioBytes48 && duration) {
      audioBytes48 = Math.round((48 * 1000 / 8) * duration);
    }

    // MP3 VBR estimate (~140 kbps)
    const mp3Bytes = Math.round((140 * 1000 / 8) * duration);

    const videoFormats = rawFormats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
    const combinedFormats = rawFormats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url);

    const standardHeights = [
      { h: 2160, tag: '4K',  badge: 'Needs processing', defBitrate: 18000 },
      { h: 1440, tag: '2K',  badge: 'Needs processing', defBitrate: 8000 },
      { h: 1080, tag: 'FHD', badge: 'Needs processing', defBitrate: 2350 },
      { h: 720,  tag: 'HD',  badge: 'HD',               defBitrate: 850 },
      { h: 480,  tag: 'SD',  badge: 'Needs processing', defBitrate: 450 },
      { h: 360,  tag: 'SD',  badge: 'SD',               defBitrate: 280 },
      { h: 240,  tag: 'SD',  badge: 'Needs processing', defBitrate: 150 },
      { h: 144,  tag: 'SD',  badge: 'Needs processing', defBitrate: 70 }
    ];

    const options = [];

    // 1. Video Formats
    for (const item of standardHeights) {
      const candidates = videoFormats.filter(vf => vf.height === item.h);
      if (!candidates.length) continue;

      // Prefer AVC1/H.264 MP4 stream with exact filesize
      const f = candidates.find(c => c.ext === 'mp4' && c.vcodec && c.vcodec.startsWith('avc1') && (c.filesize || c.filesize_approx)) ||
                candidates.find(c => c.ext === 'mp4' && (c.filesize || c.filesize_approx)) ||
                candidates.find(c => c.filesize || c.filesize_approx) ||
                candidates[0];

      let vSize = f ? (f.filesize || f.filesize_approx) : 0;
      if (!vSize && duration) {
        vSize = Math.round((item.defBitrate * 1000 / 8) * duration);
      }

      const hasAudio = f && f.acodec && f.acodec !== 'none';
      const totalSize = hasAudio ? vSize : (vSize + audioBytes140);
      const matchingCombined = combinedFormats.find(cf => cf.height === item.h);

      options.push({
        id: `height_${item.h}`,
        group: 'video',
        label: `${item.h}p · MP4`,
        quality: `${item.h}p`,
        resolutionTag: item.tag,
        ext: 'mp4',
        type: 'video',
        filesize: totalSize,
        badge: item.badge,
        directUrl: (IS_VERCEL && matchingCombined) ? matchingCombined.url : null
      });
    }

    // 2. Audio Formats
    options.push({
      id: 'audio_m4a_128',
      group: 'audio',
      label: 'M4A · 128 kbps',
      quality: '128 kbps',
      resolutionTag: 'M4A',
      ext: 'm4a',
      type: 'audio',
      filesize: audioBytes140,
      badge: 'Audio',
      directUrl: (IS_VERCEL && m4a140 && m4a140.url) ? m4a140.url : null
    });

    options.push({
      id: 'audio_m4a_48',
      group: 'audio',
      label: 'M4A · 48 kbps',
      quality: '48 kbps',
      resolutionTag: 'M4A',
      ext: 'm4a',
      type: 'audio',
      filesize: audioBytes48,
      badge: 'Audio',
      directUrl: (IS_VERCEL && m4a48 && m4a48.url) ? m4a48.url : null
    });

    options.push({
      id: 'best_audio',
      group: 'audio',
      label: 'MP3 · VBR',
      quality: 'VBR',
      resolutionTag: 'MP3',
      ext: 'mp3',
      type: 'audio',
      filesize: mp3Bytes,
      badge: 'Audio',
      directUrl: null
    });

    const responsePayload = {
      title: info.title || info.fulltitle || 'YouTube Video',
      uploader: info.uploader || info.channel || info.creator || 'YouTube Creator',
      channel: info.channel || info.uploader || info.creator || 'YouTube Creator',
      description: info.description || '',
      duration: info.duration || 0,
      duration_string: info.duration_string || '',
      thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
      webpage_url: info.webpage_url || normalizedUrl,
      platform: 'youtube',
      extractor: 'YouTube',
      view_count: info.view_count || null,
      like_count: info.like_count || null,
      comment_count: info.comment_count || null,
      isServerless: IS_VERCEL,
      options
    };

    infoCache.set(normalizedUrl, { timestamp: Date.now(), data: responsePayload });
    res.json(responsePayload);
  } catch (err) {
    console.error('Info error, falling back to cloud extractor:', err.message);
    try {
      const fallbackData = await fetchCloudYouTubeInfo(normalizedUrl);
      infoCache.set(normalizedUrl, { timestamp: Date.now(), data: fallbackData });
      return res.json(fallbackData);
    } catch {
      res.status(500).json({
        error: err.message || 'Unable to fetch YouTube video details. Please verify the link and try again.'
      });
    }
  }
});

// Start a tracked download job (yt-dlp with monotonic live progress & FFmpeg merging)
app.post('/api/start-download', async (req, res) => {
  const { url, format, title, type } = req.body;
  const normalizedUrl = normalizeYouTubeUrl(url);
  if (!normalizedUrl) {
    return res.status(400).json({ error: 'Valid YouTube URL is required' });
  }

  try {
    await ensureYtDlp();
  } catch {
    return res.status(503).json({ error: 'Downloader engine is initializing, please try again shortly.' });
  }

  const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cleanTitle = sanitizeFilename(title || 'youtube_video');
  const tempOutputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

  const { args, isAudio, expectedExt } = buildYtDlpDownloadArgs({
    url: normalizedUrl,
    format,
    type,
    tempOutputTemplate
  });

  const job = {
    id: jobId,
    status: 'downloading',
    percent: 0,
    streamCount: 0,
    totalSize: '',
    speed: '',
    eta: '',
    stageText: 'Initializing stream...',
    cleanTitle,
    ext: expectedExt,
    filePath: null,
    fileName: null,
    error: null,
    createdAt: Date.now()
  };

  downloadJobs.set(jobId, job);

  const proc = spawn(YT_DLP_PATH, args);
  job.proc = proc;
  let stderr = '';

  const parseProgressLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.includes('[download] Destination:')) {
      job.streamCount += 1;
      return;
    }

    if (trimmed.includes('[Merger]') || trimmed.includes('Merging formats') || trimmed.includes('[ExtractAudio]')) {
      job.status = 'merging';
      job.percent = 99;
      job.stageText = isAudio
        ? 'Finalizing high-quality audio...'
        : 'Merging HD Video & Audio into MP4...';
      return;
    }

    const match = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([^\s]+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i);
    if (match) {
      const rawPct = parseFloat(match[1]);
      if (!isNaN(rawPct)) {
        let weightedPct = rawPct;
        if (!isAudio) {
          // Video stream (stream 1) = 0%..85%, Audio stream (stream 2) = 85%..98%
          if (job.streamCount <= 1) {
            weightedPct = rawPct * 0.85;
          } else {
            weightedPct = 85 + (rawPct * 0.13);
          }
        } else {
          weightedPct = rawPct * 0.98;
        }
        job.percent = Math.min(99, Math.max(job.percent, weightedPct));
      }
      if (match[2] && match[2] !== 'N/A') job.totalSize = match[2];
      if (match[3] && match[3] !== 'N/A' && match[3] !== 'Unknown') job.speed = match[3];
      if (match[4] && match[4] !== 'N/A' && match[4] !== 'Unknown') job.eta = match[4];

      const stagePrefix = (!isAudio && job.streamCount > 1)
        ? 'Downloading Audio Track'
        : (isAudio ? 'Downloading Audio' : 'Downloading HD Video');
      job.stageText = `${stagePrefix}... ${job.percent.toFixed(1)}%`;
    }
  };

  proc.stdout.on('data', (data) => {
    data.toString().split(/\r?\n/).forEach(parseProgressLine);
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    text.split(/\r?\n/).forEach(parseProgressLine);
  });

  proc.on('close', (code) => {
    const files = fs.readdirSync(TEMP_DIR).filter(
      f => f.startsWith(jobId) && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.temp.mp4')
    );

    if (code !== 0 || files.length === 0) {
      job.status = 'error';
      job.error = stderr.trim() || 'Failed to download YouTube media. Please try another quality option.';
      return;
    }

    const finalFile = files[0];
    const actualExt = path.extname(finalFile).replace('.', '') || expectedExt;
    job.filePath = path.join(TEMP_DIR, finalFile);
    job.fileName = `${cleanTitle}.${actualExt}`;
    job.percent = 100;
    job.status = 'completed';
    job.stageText = '100% Complete! Saving file to your device...';
  });

  res.json({ jobId });
});

// Live progress polling endpoint
app.get('/api/progress/:jobId', (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Download session not found' });
  }
  res.json({
    id: job.id,
    status: job.status,
    percent: job.percent,
    totalSize: job.totalSize,
    speed: job.speed,
    eta: job.eta,
    stageText: job.stageText,
    error: job.error
  });
});

// Serve completed file to user's browser
app.get('/api/file/:jobId', (req, res) => {
  const job = downloadJobs.get(req.params.jobId);
  if (!job || job.status !== 'completed' || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).send('File not ready or already downloaded.');
  }

  res.download(job.filePath, job.fileName, () => {
    fs.unlink(job.filePath, () => {});
    downloadJobs.delete(job.id);
  });
});

// Direct single-request download endpoint (used when job polling isn't available)
app.get('/api/download', async (req, res) => {
  const { url, format, title, type } = req.query;
  const normalizedUrl = normalizeYouTubeUrl(url);
  if (!normalizedUrl) return res.status(400).send('Valid YouTube URL is required');

  try {
    await ensureYtDlp();
  } catch {
    return res.status(503).send('Downloader engine is initializing, please try again shortly.');
  }

  const cleanTitle = sanitizeFilename(title || 'youtube_video');
  const tempId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempOutputTemplate = path.join(TEMP_DIR, `${tempId}.%(ext)s`);

  const { args, expectedExt } = buildYtDlpDownloadArgs({
    url: normalizedUrl,
    format,
    type,
    tempOutputTemplate
  });

  const proc = spawn(YT_DLP_PATH, args);
  let stderr = '';

  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    const files = fs.readdirSync(TEMP_DIR).filter(
      f => f.startsWith(tempId) && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.temp.mp4')
    );

    if (code !== 0 || files.length === 0) {
      if (!res.headersSent) {
        return res.status(500).send(stderr.trim() || 'Failed to download YouTube video.');
      }
      return;
    }

    const downloadedFile = path.join(TEMP_DIR, files[0]);
    const actualExt = path.extname(files[0]).replace('.', '') || expectedExt;
    const downloadFileName = `${cleanTitle}.${actualExt}`;

    res.download(downloadedFile, downloadFileName, () => {
      fs.unlink(downloadedFile, () => {});
    });
  });
});

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

module.exports = app;
