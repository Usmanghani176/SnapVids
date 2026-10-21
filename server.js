const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BASE_WRITABLE_DIR = IS_VERCEL ? '/tmp' : __dirname;
const BIN_DIR = path.join(BASE_WRITABLE_DIR, 'bin');
const YT_DLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const TEMP_DIR = path.join(BASE_WRITABLE_DIR, 'temp_downloads');

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let isBinaryReady = false;
let binaryDownloadPromise = null;

// Active download jobs map for local live progress tracking
const downloadJobs = new Map();

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
              if (process.platform !== 'win32') {
                fs.chmodSync(tempDest, 0o755);
              }
              if (fs.existsSync(dest)) {
                try { fs.unlinkSync(dest); } catch {}
              }
              fs.renameSync(tempDest, dest);
              if (process.platform !== 'win32') {
                fs.chmodSync(dest, 0o755);
              }
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

  console.log('Downloading yt-dlp engine...');
  binaryDownloadPromise = downloadFileAtomic(downloadUrl, YT_DLP_PATH)
    .then(() => {
      console.log('yt-dlp engine downloaded and permissions set!');
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

ensureYtDlp().catch(() => {});

function detectPlatform(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  return 'other';
}

function sanitizeFilename(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'video';
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {})
      }
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Cloud fallback for TikTok via TikWM API (works reliably on serverless IPs)
async function fetchTikTokFallback(url) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const res = await fetchJson(apiUrl);
  if (!res || res.code !== 0 || !res.data) {
    throw new Error('TikTok fallback unavailable');
  }
  const d = res.data;
  const options = [];
  if (d.hdplay) {
    options.push({
      id: 'direct_hd',
      label: 'Best Quality (HD No Watermark)',
      quality: 'HD',
      ext: 'mp4',
      type: 'video',
      filesize: d.hd_size || d.size || null,
      badge: 'HD',
      directUrl: d.hdplay
    });
  }
  if (d.play) {
    options.push({
      id: 'direct_sd',
      label: 'Standard Video (No Watermark)',
      quality: 'SD',
      ext: 'mp4',
      type: 'video',
      filesize: d.size || null,
      badge: 'MP4',
      directUrl: d.play
    });
  }
  if (d.music) {
    options.push({
      id: 'direct_audio',
      label: 'Audio Only (MP3)',
      quality: 'Audio',
      ext: 'mp3',
      type: 'audio',
      badge: 'Audio',
      directUrl: d.music
    });
  }
  return {
    title: d.title || 'TikTok Video',
    uploader: (d.author && (d.author.nickname || d.author.unique_id)) || 'TikTok Creator',
    duration: d.duration || 0,
    duration_string: '',
    thumbnail: d.cover || d.origin_cover || '',
    webpage_url: url,
    platform: 'tiktok',
    extractor: 'TikTok',
    view_count: d.play_count || null,
    like_count: d.digg_count || null,
    isServerless: IS_VERCEL,
    options
  };
}

function runYtDlpJson(url) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureYtDlp();
    } catch (e) {
      return reject(new Error('Downloader engine is still initializing. Please try again in a moment.'));
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
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr.trim() || 'Could not fetch video details. Make sure the link is public and valid.'));
      }
      try {
        const info = JSON.parse(stdout);
        resolve(info);
      } catch (err) {
        reject(new Error('Failed to parse media info from the link.'));
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

// Thumbnail proxy
app.get('/api/thumbnail', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing URL');

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
      res.setHeader('Cache-Control', 'public, max-age=3600');
      proxyRes.pipe(res);
    }).on('error', () => {
      res.status(500).send('Failed to load thumbnail');
    });
  } catch (e) {
    res.status(400).send('Invalid URL');
  }
});

// Direct stream proxy for direct CDN URLs
app.get('/api/proxy-download', (req, res) => {
  const { directUrl, title, ext } = req.query;
  if (!directUrl) return res.status(400).send('Missing directUrl');

  const cleanTitle = sanitizeFilename(title || 'video');
  const fileExt = (ext || 'mp4').replace(/[^a-z0-9]/gi, '');

  const streamUrl = (targetUrl) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': parsed.origin
      }
    }, (upRes) => {
      if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
        return streamUrl(upRes.headers.location);
      }
      res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle}.${fileExt}"`);
      res.setHeader('Content-Type', upRes.headers['content-type'] || 'application/octet-stream');
      if (upRes.headers['content-length']) {
        res.setHeader('Content-Length', upRes.headers['content-length']);
      }
      upRes.pipe(res);
    }).on('error', () => {
      if (!res.headersSent) res.status(500).send('Failed to proxy media stream.');
    });
  };

  try {
    streamUrl(directUrl);
  } catch (e) {
    res.status(400).send('Invalid stream URL');
  }
});

// Fetch video metadata & available quality options
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Please enter a valid video link.' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL format. Please paste a full link (starting with https://).' });
  }

  const platform = detectPlatform(parsedUrl.href);

  try {
    const info = await runYtDlpJson(parsedUrl.href);

    const rawFormats = Array.isArray(info.formats) ? info.formats : [];
    const options = [];

    const audioFormats = rawFormats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
    const bestAudio = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    const audioBytes = bestAudio ? (bestAudio.filesize || bestAudio.filesize_approx || 0) : 0;

    // Find combined (video+audio) formats with direct https URLs (useful on serverless)
    const combinedFormats = rawFormats
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url && f.protocol && f.protocol.startsWith('http'))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    options.push({
      id: 'best_mp4',
      label: 'Best Quality (HD MP4)',
      quality: 'Auto / Best',
      ext: 'mp4',
      type: 'video',
      badge: 'Recommended',
      directUrl: (IS_VERCEL && combinedFormats[0]) ? combinedFormats[0].url : null
    });

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
      title: info.title || info.fulltitle || 'Social Media Video',
      uploader: info.uploader || info.channel || info.creator || info.extractor_key || 'Creator',
      duration: info.duration || 0,
      duration_string: info.duration_string || '',
      thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
      webpage_url: info.webpage_url || parsedUrl.href,
      platform,
      extractor: info.extractor_key || platform,
      view_count: info.view_count || null,
      like_count: info.like_count || null,
      isServerless: IS_VERCEL,
      options
    });
  } catch (err) {
    console.error('Info error:', err.message);
    if (platform === 'tiktok') {
      try {
        const fbData = await fetchTikTokFallback(parsedUrl.href);
        return res.json(fbData);
      } catch {}
    }
    res.status(500).json({
      error: err.message || 'Unable to fetch video information. Please check the URL and try again.'
    });
  }
});

// Single-request download endpoint (used on Vercel serverless & direct fallback)
app.get('/api/download', async (req, res) => {
  const { url, format, title, type } = req.query;
  if (!url) return res.status(400).send('URL is required');

  try {
    await ensureYtDlp();
  } catch (e) {
    return res.status(503).send('Downloader engine is initializing, please try again shortly.');
  }

  const cleanTitle = sanitizeFilename(title || 'video');
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
    if (!isAudio) {
      args.push('--merge-output-format', 'mp4');
    }
  }

  args.push(url);

  const proc = spawn(YT_DLP_PATH, args);
  let stderr = '';

  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  proc.on('close', (code) => {
    const files = fs.readdirSync(TEMP_DIR).filter(
      f => f.startsWith(tempId) && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.temp.mp4')
    );

    if (code !== 0 || files.length === 0) {
      if (!res.headersSent) {
        return res.status(500).send(stderr.trim() || 'Failed to download media.');
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

// Start a tracked download job so frontend can show real-time 0% -> 100% progress
app.post('/api/start-download', async (req, res) => {
  const { url, format, title, type } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    await ensureYtDlp();
  } catch (e) {
    return res.status(503).json({ error: 'Downloader engine is initializing, please try again shortly.' });
  }

  const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cleanTitle = sanitizeFilename(title || 'video');
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
      job.error = stderr.trim() || 'Failed to download media. Please try another quality option.';
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

// Get live progress of a download job
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

// Serve completed file to Chrome Download Manager
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

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

module.exports = app;
