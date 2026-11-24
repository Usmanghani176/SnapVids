const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const ffmpegPath = require('ffmpeg-static');
const btch = require('btch-downloader');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = !!process.env.VERCEL;

// Global crash shields so an unexpected socket reset never stops the Node server
process.on('uncaughtException', (err) => {
  console.error('[CrashShield] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CrashShield] Unhandled Rejection:', reason);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Writable directory setup (/tmp on Vercel serverless, project root locally)
const BASE_WRITABLE_DIR = IS_VERCEL ? '/tmp' : __dirname;
const BIN_DIR = path.join(BASE_WRITABLE_DIR, 'bin');
const YT_DLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

let isBinaryReady = IS_VERCEL;
let binaryDownloadPromise = null;

// Caches and live stream state
const infoCache = new Map();       // normalizedUrl -> { timestamp, data, rawInfo }
const streamTickets = new Map();   // ticketId -> stream session
const INFO_CACHE_TTL_MS = 10 * 60 * 1000;
const TICKET_TTL_MS = 15 * 60 * 1000;
const MAX_CONCURRENT_STREAMS = 3;
const RANGE_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunks avoid YouTube's ~10-50MB throttling cutoff

const YT_EXTRACTOR_ARGS = 'youtube:player_client=web_safari,visionos;player_js_variant=main';

// Extract & normalize YouTube URL from raw input or mobile share text
function normalizeYouTubeUrl(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let str = rawInput.trim();

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

    return isYt ? parsed.href : null;
  } catch {
    return null;
  }
}

// Sanitize filename safely for OS and RFC-5987 Content-Disposition headers
function sanitizeFilename(name) {
  return (name || 'youtube_video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'youtube_video';
}

function buildContentDisposition(title, ext) {
  const cleanTitle = sanitizeFilename(title);
  const asciiTitle = cleanTitle.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim() || 'youtube_video';
  const fileExt = (ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const encodedFullFile = encodeURIComponent(`${cleanTitle}.${fileExt}`);
  return `attachment; filename="${asciiTitle}.${fileExt}"; filename*=UTF-8''${encodedFullFile}`;
}

function getActiveStreamCount() {
  let count = 0;
  for (const ticket of streamTickets.values()) {
    if (ticket.status === 'streaming') count += 1;
  }
  return count;
}

// Periodic cleanup for stale cache entries and finished stream tickets
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of infoCache.entries()) {
    if (now - entry.timestamp > INFO_CACHE_TTL_MS) infoCache.delete(key);
  }
  for (const [id, ticket] of streamTickets.entries()) {
    if (ticket.status !== 'streaming' && now - ticket.createdAt > TICKET_TTL_MS) {
      streamTickets.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// Atomic binary downloader for yt-dlp
function downloadFileAtomic(url, dest) {
  const tempDest = `${dest}.downloading_${Date.now()}`;
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
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

// Ensure yt-dlp engine exists
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

  console.log('Downloading latest yt-dlp engine...');
  binaryDownloadPromise = downloadFileAtomic(downloadUrl, YT_DLP_PATH)
    .then(() => {
      console.log('yt-dlp engine ready!');
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

function parseQueryParam(urlStr, paramName) {
  try {
    const decoded = decodeURIComponent(urlStr);
    const match = decoded.match(new RegExp(`[?&]${paramName}=([0-9.]+)`));
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

// Cloud fallback extractor (used if yt-dlp encounters datacenter IP rate limits)
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

  // Only offer formats the cloud extractor can actually deliver (one combined MP4 + one audio file).
  // Advertising 1080p here would send the user into yt-dlp again, which is exactly what just failed.
  const options = [];
  if (yt.mp4) {
    options.push({
      id: 'cloud_mp4',
      group: 'video',
      label: 'MP4 · Best available',
      quality: 'MP4',
      resolutionTag: 'Direct',
      ext: 'mp4',
      type: 'video',
      filesize: Math.round((850 * 1000 / 8) * dur) + aSize128,
      badge: 'Direct',
      directUrl: yt.mp4
    });
  }
  if (yt.mp3) {
    options.push({
      id: 'cloud_audio',
      group: 'audio',
      label: 'MP3 · Audio',
      quality: 'Audio',
      resolutionTag: 'MP3',
      ext: 'mp3',
      type: 'audio',
      filesize: mp3Size,
      badge: 'Audio',
      directUrl: yt.mp3
    });
  }

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
    isServerless: IS_VERCEL,
    options
  };
}

// Run yt-dlp to inspect video/audio formats and stream URLs (with 35s timeout)
function runYtDlpJson(url) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureYtDlp();
    } catch {
      return reject(new Error('Downloader engine is initializing. Please try again in a moment.'));
    }

    const args = [
      '--js-runtimes', 'node',
      '--extractor-args', YT_EXTRACTOR_ARGS,
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
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, 35000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (timedOut) {
        return reject(new Error('YouTube metadata request timed out. Please try again.'));
      }
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || 'Could not fetch YouTube video details. Make sure the video is public and valid.'));
      }
      try {
        const info = JSON.parse(stdout);
        if (!info || typeof info !== 'object') {
          return reject(new Error('YouTube blocked this request from the server. Please try again, or pick the "Best available" option.'));
        }
        resolve(info);
      } catch {
        reject(new Error('Failed to parse YouTube video information.'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

// Fetch a byte range [start, end] from YouTube CDN with automatic retry and abort support
function fetchHttpRangeChunk(targetUrl, headers, start, end, signal, attempt = 0) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Aborted'));

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return reject(new Error('Invalid stream URL'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(headers || {}),
      'Range': `bytes=${start}-${end}`
    };

    const req = client.get(targetUrl, { headers: reqHeaders, rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, targetUrl).href;
        return fetchHttpRangeChunk(nextUrl, headers, start, end, signal, attempt).then(resolve, reject);
      }

      if (res.statusCode >= 400) {
        res.resume();
        if (attempt < 4 && (!signal || !signal.aborted)) {
          return setTimeout(() => {
            fetchHttpRangeChunk(targetUrl, headers, start, end, signal, attempt + 1).then(resolve, reject);
          }, 300);
        }
        return reject(new Error(`Upstream CDN returned HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (err) => {
        if (attempt < 4 && (!signal || !signal.aborted)) {
          return setTimeout(() => {
            fetchHttpRangeChunk(targetUrl, headers, start, end, signal, attempt + 1).then(resolve, reject);
          }, 300);
        }
        reject(err);
      });
    });

    if (signal) {
      signal.onAbort.push(() => {
        try { req.destroy(); } catch {}
      });
    }

    req.on('error', (err) => {
      if (attempt < 4 && (!signal || !signal.aborted)) {
        return setTimeout(() => {
          fetchHttpRangeChunk(targetUrl, headers, start, end, signal, attempt + 1).then(resolve, reject);
        }, 300);
      }
      reject(err);
    });
  });
}

// Resolve exact byte length of an HTTPS stream if not explicitly reported by yt-dlp
async function resolveStreamByteLength(streamObj) {
  if (streamObj.size && streamObj.size > 0) return streamObj.size;
  const clen = parseQueryParam(streamObj.url, 'clen');
  if (clen && clen > 0) return clen;

  return new Promise((resolve) => {
    try {
      const parsed = new URL(streamObj.url);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(streamObj.url, {
        headers: { ...(streamObj.headers || {}), 'Range': 'bytes=0-0' },
        rejectUnauthorized: false
      }, (res) => {
        res.resume();
        const cr = res.headers['content-range'];
        if (cr) {
          const m = cr.match(/\/(\d+)$/);
          if (m) return resolve(parseInt(m[1], 10));
        }
        const cl = res.headers['content-length'];
        resolve(cl ? parseInt(cl, 10) : 0);
      });
      req.on('error', () => resolve(0));
    } catch {
      resolve(0);
    }
  });
}

// Stream a byte range from YouTube using 4MB sliding lookahead prefetch into an HTTP ServerResponse
async function streamRangeWithPrefetch(streamObj, start, end, res, signal, onBytesWritten) {
  let pos = start;
  const firstEnd = Math.min(end, pos + RANGE_CHUNK_SIZE - 1);
  let pendingPromise = pos <= end
    ? fetchHttpRangeChunk(streamObj.url, streamObj.headers, pos, firstEnd, signal)
    : null;

  while (pendingPromise && !signal.aborted) {
    const curPos = pos;
    const curEnd = Math.min(end, curPos + RANGE_CHUNK_SIZE - 1);
    const nextStart = curEnd + 1;

    let nextPromise = null;
    if (nextStart <= end && !signal.aborted) {
      const nextEnd = Math.min(end, nextStart + RANGE_CHUNK_SIZE - 1);
      nextPromise = fetchHttpRangeChunk(streamObj.url, streamObj.headers, nextStart, nextEnd, signal);
    }

    const buf = await pendingPromise;
    if (signal.aborted || res.destroyed || res.writableEnded) break;

    const ok = res.write(buf);
    if (onBytesWritten) onBytesWritten(buf.length);
    if (!ok) {
      await new Promise((r) => res.once('drain', r));
    }

    if (buf.length === 0) break;
    pos = curEnd + 1;
    pendingPromise = nextPromise;
  }
}

// Create an ephemeral local HTTP Range-Bridge server for FFmpeg live muxing
function createLocalRangeBridge(streamMap) {
  const bridge = http.createServer(async (req, res) => {
    const key = req.url.includes('audio') ? 'audio' : 'video';
    const st = streamMap[key];
    if (!st || !st.url || !st.size) {
      res.writeHead(404);
      return res.end('Stream not found');
    }

    const rangeHdr = req.headers.range;
    let start = 0;
    let end = st.size - 1;

    if (rangeHdr) {
      const m = rangeHdr.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(st.size - 1, parseInt(m[2], 10));
      }
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': (end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes'
      });
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes'
      });
    }

    const signal = { aborted: false, onAbort: [] };
    res.on('close', () => {
      signal.aborted = true;
      signal.onAbort.forEach((fn) => fn());
    });

    try {
      await streamRangeWithPrefetch(st, start, end, res, signal);
    } catch (err) {
      if (!signal.aborted) {
        console.error(`[RangeBridge ${key}] error:`, err.message);
      }
    }

    if (!res.writableEnded) res.end();
  });

  return new Promise((resolve, reject) => {
    bridge.on('error', reject);
    bridge.listen(0, '127.0.0.1', () => {
      resolve({
        bridge,
        port: bridge.address().port
      });
    });
  });
}

// Build option list & stream selection map from raw yt-dlp JSON info
function buildOptionsAndStreams(info, normalizedUrl) {
  const rawFormats = Array.isArray(info.formats) ? info.formats : [];
  const duration = info.duration || 0;

  // Audio streams
  const m4a140 = rawFormats.find(f => f.format_id === '140' && f.url) ||
                 rawFormats.find(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.ext === 'm4a' && f.protocol === 'https' && f.url) ||
                 rawFormats.find(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.url);

  const m4a48 = rawFormats.find(f => (f.format_id === '139' || f.format_id === '249') && f.url) ||
                rawFormats.find(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.abr && f.abr <= 64 && f.url) ||
                m4a140;

  const hlsAudio = rawFormats.find(f => f.format_id === '234' && f.url) ||
                   rawFormats.find(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.protocol && f.protocol.includes('m3u8'));

  let audioBytes140 = m4a140 ? (m4a140.filesize || m4a140.filesize_approx || parseQueryParam(m4a140.url, 'clen') || 0) : 0;
  if (!audioBytes140 && duration) {
    audioBytes140 = Math.round((128 * 1000 / 8) * duration);
  }

  let audioBytes48 = m4a48 ? (m4a48.filesize || m4a48.filesize_approx || parseQueryParam(m4a48.url, 'clen') || 0) : 0;
  if (!audioBytes48 && duration) {
    audioBytes48 = Math.round((48 * 1000 / 8) * duration);
  }

  const mp3Bytes = Math.round((140 * 1000 / 8) * duration);

  const videoFormats = rawFormats.filter(f => f.vcodec && f.vcodec !== 'none' && (f.height || f.width) && f.url);
  const combinedHttps = rawFormats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.protocol === 'https' && f.url);

  // Standard target resolutions (normalized with Math.min(w, h) so portrait Shorts also match 1080p/720p!)
  const standardRes = [
    { h: 1080, tag: 'FHD', badge: 'Needs processing', defBitrate: 2350 },
    { h: 720,  tag: 'HD',  badge: 'HD',               defBitrate: 850 },
    { h: 480,  tag: 'SD',  badge: 'Needs processing', defBitrate: 450 },
    { h: 360,  tag: 'SD',  badge: 'SD',               defBitrate: 280 },
    { h: 240,  tag: 'SD',  badge: 'Needs processing', defBitrate: 150 },
    { h: 144,  tag: 'SD',  badge: 'Needs processing', defBitrate: 70 }
  ];

  const options = [];
  const formatMap = new Map();

  for (const item of standardRes) {
    const candidates = videoFormats.filter((vf) => {
      const normalizedRes = vf.width && vf.height ? Math.min(vf.width, vf.height) : vf.height;
      return normalizedRes === item.h;
    });

    if (!candidates.length) continue;

    // Prefer HTTPS H.264/AVC1 MP4 for clean copy muxing & exact byte length
    const httpsF =
      candidates.find(c => c.protocol === 'https' && c.ext === 'mp4' && c.vcodec && c.vcodec.startsWith('avc1') && (c.filesize || c.filesize_approx || parseQueryParam(c.url, 'clen'))) ||
      candidates.find(c => c.protocol === 'https' && c.ext === 'mp4' && (c.filesize || c.filesize_approx || parseQueryParam(c.url, 'clen'))) ||
      candidates.find(c => c.protocol === 'https' && c.ext === 'mp4');

    const hlsF =
      candidates.find(c => c.protocol && c.protocol.includes('m3u8') && c.vcodec && c.vcodec.startsWith('avc1')) ||
      candidates.find(c => c.protocol && c.protocol.includes('m3u8'));

    const chosenVideo = httpsF || hlsF || candidates[0];
    const matchingCombined = combinedHttps.find((cf) => {
      const normalizedRes = cf.width && cf.height ? Math.min(cf.width, cf.height) : cf.height;
      return normalizedRes === item.h;
    });

    let vSize = chosenVideo ? (chosenVideo.filesize || chosenVideo.filesize_approx || parseQueryParam(chosenVideo.url, 'clen') || 0) : 0;
    if (!vSize && duration) {
      vSize = Math.round((item.defBitrate * 1000 / 8) * duration);
    }

    const hasAudioEmbedded = chosenVideo && chosenVideo.acodec && chosenVideo.acodec !== 'none';
    const totalSize = hasAudioEmbedded ? vSize : (vSize + audioBytes140);
    const id = `height_${item.h}`;

    options.push({
      id,
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

    // Save exact stream descriptors in server memory for instant Chrome streaming
    const chosenAudio = (!hasAudioEmbedded)
      ? ((chosenVideo.protocol && chosenVideo.protocol.includes('m3u8') && !m4a140) ? hlsAudio : m4a140)
      : null;

    formatMap.set(id, {
      mode: hasAudioEmbedded ? 'single' : 'merge',
      ext: 'mp4',
      mimeType: 'video/mp4',
      expectedBytes: totalSize,
      video: {
        url: chosenVideo.url,
        size: chosenVideo.filesize || chosenVideo.filesize_approx || parseQueryParam(chosenVideo.url, 'clen') || 0,
        protocol: chosenVideo.protocol || 'https',
        headers: chosenVideo.http_headers || {}
      },
      audio: chosenAudio ? {
        url: chosenAudio.url,
        size: chosenAudio.filesize || chosenAudio.filesize_approx || parseQueryParam(chosenAudio.url, 'clen') || 0,
        protocol: chosenAudio.protocol || 'https',
        headers: chosenAudio.http_headers || {}
      } : null
    });
  }

  // Audio options
  if (m4a140) {
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
      directUrl: IS_VERCEL ? m4a140.url : null
    });
    formatMap.set('audio_m4a_128', {
      mode: 'single',
      ext: 'm4a',
      mimeType: 'audio/mp4',
      expectedBytes: audioBytes140,
      video: {
        url: m4a140.url,
        size: m4a140.filesize || m4a140.filesize_approx || parseQueryParam(m4a140.url, 'clen') || audioBytes140,
        protocol: m4a140.protocol || 'https',
        headers: m4a140.http_headers || {}
      },
      audio: null
    });
  }

  if (m4a48) {
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
      directUrl: IS_VERCEL ? m4a48.url : null
    });
    formatMap.set('audio_m4a_48', {
      mode: 'single',
      ext: 'm4a',
      mimeType: 'audio/mp4',
      expectedBytes: audioBytes48,
      video: {
        url: m4a48.url,
        size: m4a48.filesize || m4a48.filesize_approx || parseQueryParam(m4a48.url, 'clen') || audioBytes48,
        protocol: m4a48.protocol || 'https',
        headers: m4a48.http_headers || {}
      },
      audio: null
    });
  }

  if (m4a140 || hlsAudio) {
    const srcAudio = m4a140 || hlsAudio;
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
    formatMap.set('best_audio', {
      mode: 'mp3',
      ext: 'mp3',
      mimeType: 'audio/mpeg',
      expectedBytes: mp3Bytes,
      video: null,
      audio: {
        url: srcAudio.url,
        size: srcAudio.filesize || srcAudio.filesize_approx || parseQueryParam(srcAudio.url, 'clen') || audioBytes140,
        protocol: srcAudio.protocol || 'https',
        headers: srcAudio.http_headers || {}
      }
    });
  }

  const data = {
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

  return { data, formatMap };
}

// Engine status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    ready: isBinaryReady,
    downloadingEngine: !!binaryDownloadPromise
  });
});

// Thumbnail proxy to bypass hotlink blocks
app.get('/api/thumbnail', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing image URL');

  try {
    const parsed = new URL(imageUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const upReq = client.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': parsed.origin
      }
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        proxyRes.resume();
        return res.redirect(`/api/thumbnail?url=${encodeURIComponent(proxyRes.headers.location)}`);
      }
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      proxyRes.pipe(res);
    });

    upReq.on('error', () => {
      if (!res.headersSent) res.status(500).send('Failed to load thumbnail');
    });

    res.on('close', () => {
      if (!res.writableEnded) upReq.destroy();
    });
  } catch {
    res.status(400).send('Invalid URL');
  }
});

// Direct proxy stream for external direct CDN URLs (pipes directly to Chrome Downloader)
app.get('/api/proxy-download', (req, res) => {
  const { directUrl, title, ext } = req.query;
  if (!directUrl) return res.status(400).send('Missing directUrl');

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': parsed.origin + '/'
      },
      rejectUnauthorized: false
    };

    const upReq = client.get(targetUrl, reqOpts, (upRes) => {
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

      res.setHeader('Content-Disposition', buildContentDisposition(title, ext));
      res.setHeader('Content-Type', upRes.headers['content-type'] || 'application/octet-stream');
      if (upRes.headers['content-length']) {
        res.setHeader('Content-Length', upRes.headers['content-length']);
      }
      upRes.pipe(res);
    });

    upReq.on('error', (err) => {
      console.error('Proxy stream error:', err.message);
      if (!res.headersSent) res.status(500).send('Failed to proxy media stream.');
    });

    res.on('close', () => {
      if (!res.writableEnded) upReq.destroy();
    });
  };

  streamUrl(directUrl);
});

// Phase 1: Analyze YouTube URL & populate metadata + quality list
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  const normalizedUrl = normalizeYouTubeUrl(url);

  if (!normalizedUrl) {
    return res.status(400).json({
      error: 'Please enter a valid YouTube link (e.g., https://youtu.be/... or https://youtube.com/watch?v=...).'
    });
  }

  const cached = infoCache.get(normalizedUrl);
  if (cached && Date.now() - cached.timestamp < INFO_CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const info = await runYtDlpJson(normalizedUrl);

    if (info.is_live) {
      return res.status(400).json({
        error: 'Active live streams cannot be downloaded while live. Please try again after the stream finishes.'
      });
    }

    const { data, formatMap } = buildOptionsAndStreams(info, normalizedUrl);
    infoCache.set(normalizedUrl, {
      timestamp: Date.now(),
      data,
      formatMap
    });

    res.json(data);
  } catch (err) {
    console.error('Info error, falling back to cloud extractor:', err.message);
    try {
      const fallbackData = await fetchCloudYouTubeInfo(normalizedUrl);
      return res.json(fallbackData);
    } catch {
      res.status(500).json({
        error: err.message || 'Unable to fetch YouTube video details. Please verify the link and try again.'
      });
    }
  }
});

// Phase 2: Prepare stream ticket before handing directly to Chrome's Download Manager
app.post('/api/prepare-download', async (req, res) => {
  const { url, format, title, directUrl } = req.body;
  const normalizedUrl = normalizeYouTubeUrl(url);

  if (!normalizedUrl) {
    return res.status(400).json({ error: 'Valid YouTube URL is required.' });
  }

  if (getActiveStreamCount() >= MAX_CONCURRENT_STREAMS) {
    return res.status(429).json({
      error: 'Server is currently streaming maximum concurrent downloads. Please wait a moment and try again.'
    });
  }

  // If a direct external CDN URL is provided (cloud fallback), stream it via the proxy
  if (directUrl) {
    const ext = format === 'cloud_audio' ? 'mp3' : (format && format.includes('audio') ? 'm4a' : 'mp4');
    return res.json({
      ticketId: null,
      mode: 'direct',
      downloadUrl: `/api/proxy-download?directUrl=${encodeURIComponent(directUrl)}&title=${encodeURIComponent(title || 'youtube_video')}&ext=${ext}`
    });
  }

  let cacheEntry = infoCache.get(normalizedUrl);
  let formatSpec = cacheEntry && cacheEntry.formatMap ? cacheEntry.formatMap.get(format) : null;

  // Refresh metadata if cache expired or empty
  if (!formatSpec) {
    try {
      const info = await runYtDlpJson(normalizedUrl);
      if (info.is_live) {
        return res.status(400).json({ error: 'Active live streams cannot be downloaded.' });
      }
      const built = buildOptionsAndStreams(info, normalizedUrl);
      cacheEntry = { timestamp: Date.now(), data: built.data, formatMap: built.formatMap };
      infoCache.set(normalizedUrl, cacheEntry);
      formatSpec = built.formatMap.get(format) || built.formatMap.values().next().value;
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Could not prepare YouTube stream.' });
    }
  }

  if (!formatSpec) {
    return res.status(404).json({ error: 'Selected quality stream was not found. Please refresh and try again.' });
  }

  // Pre-verify byte sizes for HTTPS streams if needed
  if (formatSpec.video && (!formatSpec.video.protocol || !formatSpec.video.protocol.includes('m3u8')) && !formatSpec.video.size) {
    formatSpec.video.size = await resolveStreamByteLength(formatSpec.video);
  }
  if (formatSpec.audio && (!formatSpec.audio.protocol || !formatSpec.audio.protocol.includes('m3u8')) && !formatSpec.audio.size) {
    formatSpec.audio.size = await resolveStreamByteLength(formatSpec.audio);
  }

  const ticketId = `st_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ticket = {
    id: ticketId,
    title: sanitizeFilename(title || cacheEntry.data.title || 'youtube_video'),
    mode: formatSpec.mode,
    ext: formatSpec.ext,
    mimeType: formatSpec.mimeType,
    expectedBytes: formatSpec.expectedBytes || 0,
    bytesSent: 0,
    speedBps: 0,
    status: 'ready', // ready -> streaming -> completed / cancelled / error
    error: null,
    video: formatSpec.video,
    audio: formatSpec.audio,
    createdAt: Date.now(),
    startedAt: null
  };

  streamTickets.set(ticketId, ticket);

  res.json({
    ticketId,
    mode: ticket.mode,
    expectedBytes: ticket.expectedBytes,
    filename: `${ticket.title}.${ticket.ext}`,
    downloadUrl: `/api/stream-download/${ticketId}`
  });
});

// Phase 3: Stream directly into Chrome's native Download Manager (NO server disk dump, NO JS Blob!)
app.get('/api/stream-download/:ticketId', async (req, res) => {
  const ticket = streamTickets.get(req.params.ticketId);
  if (!ticket) {
    return res.status(404).send('Download link expired. Please click Download again.');
  }

  if (ticket.status !== 'ready') {
    return res.status(409).send('This download stream has already been started.');
  }

  ticket.status = 'streaming';
  ticket.startedAt = Date.now();

  const disposition = buildContentDisposition(ticket.title, ticket.ext);

  // CASE 1: Direct Single Stream (e.g. M4A 128k, M4A 48k, or combined progressive MP4)
  // Sends exact Content-Length so Chrome shows native % progress and Pause/Resume!
  if (ticket.mode === 'single' && ticket.video && ticket.video.size > 0 && (!ticket.video.protocol || !ticket.video.protocol.includes('m3u8'))) {
    const totalSize = ticket.video.size;
    const rangeHdr = req.headers.range;
    let start = 0;
    let end = totalSize - 1;

    if (rangeHdr) {
      const m = rangeHdr.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(totalSize - 1, parseInt(m[2], 10));
      }
      res.writeHead(206, {
        'Content-Disposition': disposition,
        'Content-Type': ticket.mimeType,
        'Content-Length': (end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
    } else {
      res.writeHead(200, {
        'Content-Disposition': disposition,
        'Content-Type': ticket.mimeType,
        'Content-Length': totalSize,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
    }

    const signal = { aborted: false, onAbort: [] };
    let completedNormally = false;

    res.on('close', () => {
      if (!completedNormally) {
        signal.aborted = true;
        signal.onAbort.forEach((fn) => fn());
        ticket.status = 'cancelled';
      }
    });

    try {
      await streamRangeWithPrefetch(ticket.video, start, end, res, signal, (len) => {
        ticket.bytesSent += len;
        const elapsed = Math.max(0.1, (Date.now() - ticket.startedAt) / 1000);
        ticket.speedBps = Math.round(ticket.bytesSent / elapsed);
      });
      completedNormally = true;
      if (!signal.aborted) ticket.status = 'completed';
    } catch (err) {
      if (!signal.aborted) {
        ticket.status = 'error';
        ticket.error = err.message;
      }
    }

    if (!res.writableEnded) res.end();
    return;
  }

  // CASE 2: Live FFmpeg Merging Pipe (1080p/720p/480p Video+Audio -> Fragmented MP4, or Audio -> MP3)
  // Streams live chunk-by-chunk straight into Chrome's native downloader with 0 MB temp disk usage!
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    ticket.status = 'error';
    ticket.error = 'FFmpeg engine is unavailable on server.';
    return res.status(500).send(ticket.error);
  }

  let bridgeInfo = null;
  const needBridgeStreams = {};

  if (ticket.video && (!ticket.video.protocol || !ticket.video.protocol.includes('m3u8')) && ticket.video.size > 0) {
    needBridgeStreams.video = ticket.video;
  }
  if (ticket.audio && (!ticket.audio.protocol || !ticket.audio.protocol.includes('m3u8')) && ticket.audio.size > 0) {
    needBridgeStreams.audio = ticket.audio;
  }

  try {
    if (Object.keys(needBridgeStreams).length > 0) {
      bridgeInfo = await createLocalRangeBridge(needBridgeStreams);
    }
  } catch (err) {
    ticket.status = 'error';
    ticket.error = 'Failed to initialize stream bridge.';
    return res.status(500).send(ticket.error);
  }

  const ffArgs = ['-hide_banner', '-loglevel', 'error'];

  if (ticket.mode === 'mp3') {
    const audioInput = needBridgeStreams.audio
      ? `http://127.0.0.1:${bridgeInfo.port}/audio`
      : ticket.audio.url;
    ffArgs.push('-i', audioInput, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3', 'pipe:1');
  } else {
    const videoInput = needBridgeStreams.video
      ? `http://127.0.0.1:${bridgeInfo.port}/video`
      : ticket.video.url;
    const isHlsVideo = !needBridgeStreams.video && ticket.video.protocol && ticket.video.protocol.includes('m3u8');

    if (isHlsVideo) ffArgs.push('-http_persistent', '1');
    ffArgs.push('-i', videoInput);

    if (ticket.audio) {
      const audioInput = needBridgeStreams.audio
        ? `http://127.0.0.1:${bridgeInfo.port}/audio`
        : ticket.audio.url;
      const isHlsAudio = !needBridgeStreams.audio && ticket.audio.protocol && ticket.audio.protocol.includes('m3u8');

      if (isHlsAudio) ffArgs.push('-http_persistent', '1');
      ffArgs.push('-i', audioInput, '-c', 'copy');
      if (isHlsAudio) ffArgs.push('-bsf:a', 'aac_adtstoasc');
    } else {
      ffArgs.push('-c', 'copy');
    }

    ffArgs.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  }

  const ff = spawn(ffmpegPath, ffArgs);
  let ffStderr = '';
  let headersSent = false;
  let clientClosed = false;

  const cleanup = () => {
    if (bridgeInfo && bridgeInfo.bridge) {
      try { bridgeInfo.bridge.close(); } catch {}
      bridgeInfo = null;
    }
  };

  res.on('close', () => {
    if (!res.writableEnded && ticket.status === 'streaming') {
      clientClosed = true;
      ticket.status = 'cancelled';
      try { ff.kill('SIGKILL'); } catch {}
      cleanup();
    }
  });

  ff.stderr.on('data', (d) => {
    ffStderr += d.toString();
  });

  ff.stdout.on('data', (chunk) => {
    if (clientClosed) return;

    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, {
        'Content-Disposition': disposition,
        'Content-Type': ticket.mimeType,
        'Cache-Control': 'no-store'
      });
    }

    const ok = res.write(chunk);
    ticket.bytesSent += chunk.length;
    const elapsed = Math.max(0.1, (Date.now() - ticket.startedAt) / 1000);
    ticket.speedBps = Math.round(ticket.bytesSent / elapsed);

    if (!ok) {
      ff.stdout.pause();
      res.once('drain', () => {
        if (!clientClosed) ff.stdout.resume();
      });
    }
  });

  ff.on('close', (code) => {
    cleanup();
    if (clientClosed) return;

    if (code !== 0 && !headersSent) {
      ticket.status = 'error';
      ticket.error = ffStderr.trim() || 'FFmpeg stream merge failed.';
      return res.status(500).send(ticket.error);
    }

    ticket.status = 'completed';
    if (!res.writableEnded) res.end();
  });

  ff.on('error', (err) => {
    cleanup();
    if (clientClosed) return;
    ticket.status = 'error';
    ticket.error = err.message;
    if (!headersSent) res.status(500).send(err.message);
    else if (!res.writableEnded) res.end();
  });
});

// Lightweight live status check for UI while Chrome downloads
app.get('/api/stream-status/:ticketId', (req, res) => {
  const ticket = streamTickets.get(req.params.ticketId);
  if (!ticket) {
    return res.status(404).json({ error: 'Stream session not found' });
  }
  res.json({
    id: ticket.id,
    status: ticket.status,
    bytesSent: ticket.bytesSent,
    expectedBytes: ticket.expectedBytes,
    speedBps: ticket.speedBps,
    error: ticket.error
  });
});

// Clear cached video metadata and finished stream tickets
app.post('/api/clear-cache', (req, res) => {
  const clearedInfo = infoCache.size;
  infoCache.clear();

  let clearedTickets = 0;
  for (const [id, ticket] of streamTickets.entries()) {
    if (ticket.status !== 'streaming') {
      streamTickets.delete(id);
      clearedTickets += 1;
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, clearedInfo, clearedTickets });
});

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

module.exports = app;
