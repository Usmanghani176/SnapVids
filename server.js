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

// Path configuration (writable /tmp directory for serverless, local dir for normal execution)
const BASE_WRITABLE_DIR = IS_VERCEL ? '/tmp' : __dirname;
const BIN_DIR = path.join(BASE_WRITABLE_DIR, 'bin');
const YT_DLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const TEMP_DIR = path.join(BASE_WRITABLE_DIR, 'temp_downloads');

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let isBinaryReady = IS_VERCEL;
let binaryDownloadPromise = null;
const downloadJobs = new Map();

// Helper: Verify YouTube URL
function isYouTubeUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'www.youtube.com' ||
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtu.be'
    );
  } catch {
    return false;
  }
}

// Helper: Sanitize Filename
function sanitizeFilename(name) {
  return (name || 'youtube_video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'youtube_video';
}

// Download yt-dlp binary with proper permissions
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

// Ensure yt-dlp binary exists
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

// Parse query params (e.g. clen, dur) from video URLs
function parseQueryParam(urlStr, paramName) {
  try {
    const decoded = decodeURIComponent(urlStr);
    const match = decoded.match(new RegExp(`[?&]${paramName}=([0-9.]+)`));
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

// Cloud fallback extractor for YouTube (runs fast on Vercel without datacenter IP blocks)
async function fetchCloudYouTubeInfo(url) {
  const yt = await btch.youtube(url);
  if (!yt || (!yt.mp4 && !yt.mp3)) {
    throw new Error('Could not extract YouTube streams from cloud extractor.');
  }

  const videoSize = yt.mp4 ? parseQueryParam(yt.mp4, 'clen') : null;
  const audioSize = yt.mp3 ? parseQueryParam(yt.mp3, 'clen') : null;
  const dur = parseQueryParam(yt.mp4 || yt.mp3 || '', 'dur') || 0;

  const options = [];
  if (yt.mp4) {
    options.push({
      id: 'cloud_yt_hd',
      label: 'Best Quality Video (HD MP4)',
      quality: 'HD',
      ext: 'mp4',
      type: 'video',
      filesize: videoSize,
      badge: 'Recommended',
      directUrl: yt.mp4
    });
  }
  if (yt.mp3) {
    options.push({
      id: 'cloud_yt_audio',
      label: 'Audio Only (MP3 / M4A)',
      quality: 'Audio',
      ext: 'm4a',
      type: 'audio',
      filesize: audioSize,
      badge: 'Audio',
      directUrl: yt.mp3
    });
  }

  return {
    title: yt.title || 'YouTube Video',
    uploader: yt.author || 'YouTube Channel',
    duration: dur,
    duration_string: '',
    thumbnail: yt.thumbnail || '',
    webpage_url: url,
    platform: 'youtube',
    extractor: 'YouTube',
    view_count: null,
    like_count: null,
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
      '--extractor-args', 'youtube:player_client=ios,android_vr,tv,web',
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

// Status check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    ready: isBinaryReady,
    downloadingEngine: !!binaryDownloadPromise
  });
});

// Thumbnail proxy to bypass hotlink protection & CORS
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

// Fetch YouTube video metadata & available quality options
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Please enter a valid YouTube video or Shorts link.' });
  }

  const trimmedUrl = url.trim();
  if (!isYouTubeUrl(trimmedUrl)) {
    return res.status(400).json({
      error: 'Only YouTube links are supported (e.g., https://youtu.be/... or https://youtube.com/watch?v=...).'
    });
  }

  // On Vercel serverless, use fast cloud-native extractor first to avoid datacenter IP rate limits
  if (IS_VERCEL) {
    try {
      const cloudData = await fetchCloudYouTubeInfo(trimmedUrl);
      return res.json(cloudData);
    } catch (cloudErr) {
      console.warn('Cloud extractor fallback to yt-dlp:', cloudErr.message);
    }
  }

  try {
    const info = await runYtDlpJson(trimmedUrl);
    const rawFormats = Array.isArray(info.formats) ? info.formats : [];
    const options = [];

    // Find best audio stream size for combined estimate
    const audioFormats = rawFormats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
    const bestAudio = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    const audioBytes = bestAudio ? (bestAudio.filesize || bestAudio.filesize_approx || 0) : 0;

    // Direct progressive combined formats
    const combinedFormats = rawFormats
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url && f.protocol && f.protocol.startsWith('http'))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    // Best Quality Option
    options.push({
      id: 'best_mp4',
      label: 'Best Quality (HD MP4)',
      quality: 'Auto / Best',
      ext: 'mp4',
      type: 'video',
      badge: 'Recommended',
      directUrl: (IS_VERCEL && combinedFormats[0]) ? combinedFormats[0].url : null
    });

    // Collect distinct resolutions (e.g. 1080p, 720p, 480p, 360p)
    const seenHeights = new Set();
    const videoFormats = rawFormats
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
      .sort((a, b) => {
        if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
        const aMp4 = (a.ext === 'mp4' ? 1 : 0);
        const bMp4 = (b.ext === 'mp4' ? 1 : 0);
        return bMp4 - aMp4;
      });

    for (const f of videoFormats) {
      const h = f.height;
      if (!seenHeights.has(h) && seenHeights.size < 5) {
        seenHeights.add(h);
        const vSize = f.filesize || f.filesize_approx || null;
        const hasAudio = f.acodec && f.acodec !== 'none';
        const totalEstimate = vSize ? (hasAudio ? vSize : vSize + audioBytes) : null;
        const matchingCombined = combinedFormats.find(cf => cf.height === h);

        options.push({
          id: `height_${h}`,
          label: `${h}p Video (MP4)`,
          quality: `${h}p`,
          ext: 'mp4',
          type: 'video',
          filesize: totalEstimate,
          badge: h >= 720 ? 'HD' : 'SD',
          directUrl: (IS_VERCEL && matchingCombined) ? matchingCombined.url : null
        });
      }
    }

    // Audio Only Option
    options.push({
      id: 'best_audio',
      label: 'Audio Only (MP3 / M4A)',
      quality: 'Audio',
      ext: 'm4a',
      type: 'audio',
      filesize: audioBytes || null,
      badge: 'Audio',
      directUrl: (IS_VERCEL && bestAudio && bestAudio.url && bestAudio.protocol && bestAudio.protocol.startsWith('http')) ? bestAudio.url : null
    });

    res.json({
      title: info.title || info.fulltitle || 'YouTube Video',
      uploader: info.uploader || info.channel || info.creator || 'YouTube Creator',
      duration: info.duration || 0,
      duration_string: info.duration_string || '',
      thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
      webpage_url: info.webpage_url || trimmedUrl,
      platform: 'youtube',
      extractor: 'YouTube',
      view_count: info.view_count || null,
      like_count: info.like_count || null,
      isServerless: IS_VERCEL,
      options
    });
  } catch (err) {
    console.error('Info error:', err.message);
    try {
      const fallbackData = await fetchCloudYouTubeInfo(trimmedUrl);
      return res.json(fallbackData);
    } catch {
      res.status(500).json({
        error: err.message || 'Unable to fetch YouTube video details. Please verify the link and try again.'
      });
    }
  }
});

// Start a tracked download job (yt-dlp with live progress & ffmpeg merging)
app.post('/api/start-download', async (req, res) => {
  const { url, format, title, type } = req.body;
  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Valid YouTube URL is required' });
  }

  try {
    await ensureYtDlp();
  } catch {
    return res.status(503).json({ error: 'Downloader engine is initializing, please try again shortly.' });
  }

  const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cleanTitle = sanitizeFilename(title || 'youtube_video');
  const isAudio = type === 'audio' || format === 'best_audio';
  const ext = isAudio ? 'm4a' : 'mp4';
  const tempOutputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

  let formatSelector = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';
  if (isAudio) {
    formatSelector = 'ba[ext=m4a]/ba/b';
  } else if (format && format !== 'best_mp4') {
    if (format.startsWith('height_')) {
      const h = parseInt(format.replace('height_', ''), 10);
      formatSelector = `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
    } else {
      formatSelector = `${format}+ba[ext=m4a]/${format}+ba/${format}/bv*+ba/b`;
    }
  }

  const args = [
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=ios,android_vr,tv,web',
    '--newline',
    '--progress',
    '-f', formatSelector,
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '-o', tempOutputTemplate
  ];

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    args.push('--ffmpeg-location', ffmpegPath);
    if (!isAudio) {
      args.push('--merge-output-format', 'mp4');
    }
  }

  args.push(url);

  const job = {
    id: jobId,
    status: 'downloading',
    percent: 0,
    totalSize: '',
    speed: '',
    eta: '',
    stageText: 'Starting download...',
    cleanTitle,
    ext,
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

    if (trimmed.includes('[Merger]') || trimmed.includes('Merging formats')) {
      job.status = 'merging';
      job.percent = 99;
      job.stageText = 'Merging HD Video & Audio into MP4...';
      return;
    }

    const match = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([^\s]+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i);
    if (match) {
      const pct = parseFloat(match[1]);
      if (!isNaN(pct)) {
        job.percent = Math.min(99, pct);
      }
      if (match[2] && match[2] !== 'N/A') job.totalSize = match[2];
      if (match[3] && match[3] !== 'N/A' && match[3] !== 'Unknown') job.speed = match[3];
      if (match[4] && match[4] !== 'N/A' && match[4] !== 'Unknown') job.eta = match[4];
      job.stageText = `Downloading... ${job.percent.toFixed(1)}%`;
    }
  };

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split(/\r?\n/);
    lines.forEach(parseProgressLine);
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
      job.error = stderr.trim() || 'Failed to download YouTube video. Please try another quality option.';
      return;
    }

    const finalFile = files[0];
    const actualExt = path.extname(finalFile).replace('.', '') || ext;
    job.filePath = path.join(TEMP_DIR, finalFile);
    job.fileName = `${cleanTitle}.${actualExt}`;
    job.percent = 100;
    job.status = 'completed';
    job.stageText = '100% Complete! Saving file to your browser...';
  });

  res.json({ jobId });
});

// Live progress polling
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

// Serve completed file to browser
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

// Direct single-request download endpoint
app.get('/api/download', async (req, res) => {
  const { url, format, title, type } = req.query;
  if (!url || !isYouTubeUrl(url)) return res.status(400).send('Valid YouTube URL is required');

  try {
    await ensureYtDlp();
  } catch {
    return res.status(503).send('Downloader engine is initializing, please try again shortly.');
  }

  const cleanTitle = sanitizeFilename(title || 'youtube_video');
  const isAudio = type === 'audio' || format === 'best_audio';
  const ext = isAudio ? 'm4a' : 'mp4';
  const tempId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempOutputTemplate = path.join(TEMP_DIR, `${tempId}.%(ext)s`);

  let formatSelector = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';
  if (isAudio) {
    formatSelector = 'ba[ext=m4a]/ba/b';
  } else if (format && format !== 'best_mp4') {
    if (format.startsWith('height_')) {
      const h = parseInt(format.replace('height_', ''), 10);
      formatSelector = `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
    } else {
      formatSelector = `${format}+ba[ext=m4a]/${format}+ba/${format}/bv*+ba/b`;
    }
  }

  const args = [
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=ios,android_vr,tv,web',
    '-f', formatSelector,
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '-o', tempOutputTemplate
  ];

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    args.push('--ffmpeg-location', ffmpegPath);
    if (!isAudio) args.push('--merge-output-format', 'mp4');
  }

  args.push(url);

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
    const actualExt = path.extname(files[0]).replace('.', '') || ext;
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
