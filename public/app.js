const form = document.getElementById('download-form');
const urlInput = document.getElementById('video-url');
const pasteBtn = document.getElementById('paste-btn');
const clearBtn = document.getElementById('clear-btn');
const fetchBtn = document.getElementById('fetch-btn');
const alertBox = document.getElementById('alert-box');
const alertMessage = document.getElementById('alert-message');
const loadingCard = document.getElementById('loading-card');
const resultCard = document.getElementById('result-card');
const themeToggle = document.getElementById('theme-toggle');
const platformTabs = document.querySelectorAll('.platform-tab');
const engineBadge = document.getElementById('engine-badge');
const engineStatusText = document.getElementById('engine-status-text');

const resThumbnail = document.getElementById('res-thumbnail');
const resDuration = document.getElementById('res-duration');
const resPlatformBadge = document.getElementById('res-platform-badge');
const resTitle = document.getElementById('res-title');
const resUploader = document.getElementById('res-uploader');
const resStats = document.getElementById('res-stats');
const optionsList = document.getElementById('options-list');

const downloadProgressNote = document.getElementById('download-progress-note');
const downloadProgressText = document.getElementById('download-progress-text');
const downloadPercentBadge = document.getElementById('download-percent-badge');
const downloadProgressBar = document.getElementById('download-progress-bar');
const downloadSizeInfo = document.getElementById('download-size-info');
const downloadSpeedInfo = document.getElementById('download-speed-info');
const progressSpinner = document.getElementById('progress-spinner');

const historySection = document.getElementById('history-section');
const historyList = document.getElementById('history-list');
const clearHistoryBtn = document.getElementById('clear-history-btn');

let activePollTimer = null;
const defaultPageTitle = document.title;

const placeholders = {
  all: 'Paste YouTube, TikTok, Instagram, or Facebook video link here...',
  youtube: 'Paste YouTube video or Shorts link (e.g., https://youtu.be/...)',
  tiktok: 'Paste TikTok video link (e.g., https://www.tiktok.com/@user/video/...)',
  instagram: 'Paste Instagram Reel or Post link (e.g., https://www.instagram.com/reel/...)',
  facebook: 'Paste Facebook Watch or Reel link (e.g., https://www.facebook.com/watch/...)'
};

// Theme Setup
const savedTheme = localStorage.getItem('streamsave_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('streamsave_theme', next);
});

// Check backend engine readiness
async function checkEngineStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.ready) {
      engineBadge.classList.remove('loading');
      engineStatusText.textContent = 'Engine Ready';
    } else {
      engineBadge.classList.add('loading');
      engineStatusText.textContent = 'Setting up Engine...';
      setTimeout(checkEngineStatus, 2500);
    }
  } catch (e) {
    setTimeout(checkEngineStatus, 4000);
  }
}
checkEngineStatus();

// Platform Tab Switching
platformTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    platformTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const p = tab.dataset.platform;
    urlInput.placeholder = placeholders[p] || placeholders.all;
    urlInput.focus();
  });
});

function detectPlatformFromUrl(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  return 'all';
}

urlInput.addEventListener('input', () => {
  const val = urlInput.value.trim();
  clearBtn.classList.toggle('hidden', !val);
  hideAlert();

  if (val) {
    const detected = detectPlatformFromUrl(val);
    platformTabs.forEach(t => {
      t.classList.toggle('active', t.dataset.platform === detected);
    });
  }
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  clearBtn.classList.add('hidden');
  hideAlert();
  urlInput.focus();
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text.trim();
      urlInput.dispatchEvent(new Event('input'));
    }
  } catch (err) {
    urlInput.focus();
    showAlert('Please press Ctrl+V to paste the link.');
  }
});

function showAlert(msg) {
  alertMessage.textContent = msg;
  alertBox.classList.remove('hidden');
}

function hideAlert() {
  alertBox.classList.add('hidden');
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function formatDuration(sec, fallbackStr) {
  if (fallbackStr) return fallbackStr;
  if (!sec || isNaN(sec)) return 'Video';
  const total = Math.round(sec);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatNumber(num) {
  if (!num || isNaN(num)) return null;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return String(num);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    showAlert('Please paste a valid video URL first.');
    return;
  }

  hideAlert();
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
  document.title = defaultPageTitle;
  resultCard.classList.add('hidden');
  downloadProgressNote.classList.add('hidden');
  loadingCard.classList.remove('hidden');
  fetchBtn.disabled = true;
  fetchBtn.querySelector('.btn-text').textContent = 'Fetching...';

  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Could not fetch video details.');
    }

    renderResult(data, url);
    saveToHistory(data, url);
  } catch (err) {
    showAlert(err.message || 'Failed to fetch video. Please check the link and try again.');
  } finally {
    loadingCard.classList.add('hidden');
    fetchBtn.disabled = false;
    fetchBtn.querySelector('.btn-text').textContent = 'Fetch Video';
  }
});

function renderResult(data, originalUrl) {
  const thumbUrl = data.thumbnail
    ? `/api/thumbnail?url=${encodeURIComponent(data.thumbnail)}`
    : 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=600&auto=format&fit=crop&q=80';

  resThumbnail.src = thumbUrl;
  resThumbnail.onerror = () => {
    resThumbnail.src = 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=600&auto=format&fit=crop&q=80';
  };

  resDuration.textContent = formatDuration(data.duration, data.duration_string);
  resPlatformBadge.textContent = (data.platform === 'other' ? data.extractor : data.platform).toUpperCase();
  resTitle.textContent = data.title;
  resUploader.textContent = data.uploader;

  resStats.innerHTML = '';
  const views = formatNumber(data.view_count);
  const likes = formatNumber(data.like_count);
  if (views) {
    resStats.innerHTML += `<span class="stat-pill">👁 ${views} views</span>`;
  }
  if (likes) {
    resStats.innerHTML += `<span class="stat-pill">♥ ${likes} likes</span>`;
  }

  optionsList.innerHTML = '';
  (data.options || []).forEach(opt => {
    const item = document.createElement('div');
    item.className = 'option-item';

    const sizeLabel = opt.filesize ? `• ~${formatBytes(opt.filesize)}` : '';
    const isAudio = opt.type === 'audio';

    item.innerHTML = `
      <div class="option-info">
        <span class="format-badge ${isAudio ? 'audio' : ''}">${opt.badge || opt.ext}</span>
        <div>
          <span class="option-title">${opt.label}</span>
          <span class="option-sub">${opt.ext.toUpperCase()} ${sizeLabel}</span>
        </div>
      </div>
      <button type="button" class="dl-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span class="dl-btn-label">Download</span>
      </button>
    `;

    const btn = item.querySelector('.dl-btn');
    btn.addEventListener('click', () => {
      startTrackedDownload({
        url: originalUrl,
        format: opt.id,
        type: opt.type,
        title: data.title,
        label: opt.label,
        ext: opt.ext,
        directUrl: opt.directUrl || null,
        isServerless: !!data.isServerless,
        clickedBtn: btn
      });
    });

    optionsList.appendChild(item);
  });

  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function startTrackedDownload({ url, format, type, title, label, ext, directUrl, isServerless, clickedBtn }) {
  hideAlert();
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }

  const allBtns = optionsList.querySelectorAll('.dl-btn');
  allBtns.forEach(b => {
    b.disabled = true;
    const lbl = b.querySelector('.dl-btn-label');
    if (lbl) lbl.textContent = 'Download';
  });

  const clickedLabel = clickedBtn.querySelector('.dl-btn-label');
  if (clickedLabel) clickedLabel.textContent = '0%...';

  progressSpinner.classList.remove('hidden');
  downloadProgressNote.classList.remove('hidden');
  downloadProgressBar.style.width = '2%';
  downloadPercentBadge.textContent = '0%';
  downloadProgressText.textContent = `Initializing ${label}...`;
  downloadSizeInfo.textContent = 'Connecting to media stream...';
  downloadSpeedInfo.textContent = '';
  downloadProgressNote.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // On Vercel serverless (stateless across HTTP requests) or direct CDN stream, download in a single request
  if (isServerless || directUrl) {
    try {
      const targetEndpoint = directUrl
        ? `/api/proxy-download?directUrl=${encodeURIComponent(directUrl)}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent(ext || 'mp4')}`
        : `/api/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}&type=${encodeURIComponent(type)}&title=${encodeURIComponent(title)}`;

      let fakePct = 5;
      activePollTimer = setInterval(() => {
        if (fakePct < 92) {
          fakePct += Math.max(1, Math.round((95 - fakePct) * 0.12));
          downloadProgressBar.style.width = `${fakePct}%`;
          downloadPercentBadge.textContent = `${fakePct}%`;
          downloadProgressText.textContent = `Downloading & Processing ${label}... ${fakePct}%`;
          if (clickedLabel) clickedLabel.textContent = `${fakePct}%`;
          document.title = `(${fakePct}%) Downloading — SnagVids`;
        }
      }, 450);

      const response = await fetch(targetEndpoint);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || 'Failed to download media.');
      }

      const blob = await response.blob();
      clearInterval(activePollTimer);
      activePollTimer = null;
      document.title = defaultPageTitle;

      downloadProgressBar.style.width = '100%';
      downloadPercentBadge.textContent = '100%';
      progressSpinner.classList.add('hidden');
      downloadProgressText.textContent = '✅ 100% Complete! File sent to Chrome Downloads.';
      downloadSizeInfo.textContent = `Size: ${formatBytes(blob.size)}`;
      downloadSpeedInfo.textContent = 'Saved to your Downloads folder';

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const safeName = (title || 'video').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 90) || 'video';
      a.download = `${safeName}.${type === 'audio' ? 'm4a' : (ext || 'mp4')}`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
        a.remove();
      }, 5000);
    } catch (err) {
      if (activePollTimer) clearInterval(activePollTimer);
      activePollTimer = null;
      document.title = defaultPageTitle;
      downloadProgressNote.classList.add('hidden');
      showAlert(err.message || 'Download failed.');
    } finally {
      allBtns.forEach(b => {
        b.disabled = false;
        const lbl = b.querySelector('.dl-btn-label');
        if (lbl) lbl.textContent = 'Download';
      });
    }
    return;
  }

  try {
    const startRes = await fetch('/api/start-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format, type, title })
    });

    const startData = await startRes.json();
    if (!startRes.ok || !startData.jobId) {
      throw new Error(startData.error || 'Could not start download.');
    }

    const jobId = startData.jobId;

    activePollTimer = setInterval(async () => {
      try {
        const progRes = await fetch(`/api/progress/${jobId}`);
        if (!progRes.ok) return;
        const prog = await progRes.json();

        const pct = Math.round(prog.percent || 0);
        downloadProgressBar.style.width = `${Math.max(3, pct)}%`;
        downloadPercentBadge.textContent = `${pct}%`;
        downloadProgressText.textContent = prog.stageText || `Downloading... ${pct}%`;
        document.title = `(${pct}%) Downloading — SnagVids`;

        if (clickedLabel) {
          clickedLabel.textContent = prog.status === 'merging' ? 'Merging...' : `${pct}%`;
        }

        if (prog.totalSize) {
          downloadSizeInfo.textContent = `Total Size: ${prog.totalSize}`;
        }
        const metaParts = [];
        if (prog.speed) metaParts.push(`Speed: ${prog.speed}`);
        if (prog.eta) metaParts.push(`ETA: ${prog.eta}`);
        downloadSpeedInfo.textContent = metaParts.join(' • ');

        if (prog.status === 'completed') {
          clearInterval(activePollTimer);
          activePollTimer = null;
          document.title = defaultPageTitle;

          downloadProgressBar.style.width = '100%';
          downloadPercentBadge.textContent = '100%';
          progressSpinner.classList.add('hidden');
          downloadProgressText.textContent = '✅ 100% Complete! File sent to Chrome Downloads.';
          downloadSpeedInfo.textContent = 'Saved to your Downloads folder';

          allBtns.forEach(b => {
            b.disabled = false;
            const lbl = b.querySelector('.dl-btn-label');
            if (lbl) lbl.textContent = 'Download';
          });

          // Trigger immediate Chrome download with full Content-Length
          const a = document.createElement('a');
          a.href = `/api/file/${jobId}`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => a.remove(), 2000);
        } else if (prog.status === 'error') {
          clearInterval(activePollTimer);
          activePollTimer = null;
          document.title = defaultPageTitle;
          downloadProgressNote.classList.add('hidden');
          showAlert(prog.error || 'Download failed. Please try another quality option.');
          allBtns.forEach(b => {
            b.disabled = false;
            const lbl = b.querySelector('.dl-btn-label');
            if (lbl) lbl.textContent = 'Download';
          });
        }
      } catch (e) {
        // Ignore transient polling hiccup
      }
    }, 350);
  } catch (err) {
    document.title = defaultPageTitle;
    downloadProgressNote.classList.add('hidden');
    showAlert(err.message || 'Failed to start download.');
    allBtns.forEach(b => {
      b.disabled = false;
      const lbl = b.querySelector('.dl-btn-label');
      if (lbl) lbl.textContent = 'Download';
    });
  }
}

// LocalStorage Recent History
function getHistory() {
  try {
    return JSON.parse(localStorage.getItem('streamsave_history') || '[]');
  } catch {
    return [];
  }
}

function saveToHistory(data, url) {
  const list = getHistory().filter(item => item.url !== url);
  list.unshift({
    title: data.title,
    platform: data.platform || 'video',
    thumbnail: data.thumbnail ? `/api/thumbnail?url=${encodeURIComponent(data.thumbnail)}` : '',
    url,
    time: Date.now()
  });
  localStorage.setItem('streamsave_history', JSON.stringify(list.slice(0, 6)));
  renderHistory();
}

function renderHistory() {
  const list = getHistory();
  if (!list.length) {
    historySection.classList.add('hidden');
    return;
  }

  historySection.classList.remove('hidden');
  historyList.innerHTML = '';

  list.forEach(item => {
    const card = document.createElement('div');
    card.className = 'history-item';
    const fallbackImg = 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=200&auto=format&fit=crop&q=60';
    card.innerHTML = `
      <img class="history-thumb" src="${item.thumbnail || fallbackImg}" alt="thumb" onerror="this.src='${fallbackImg}'" />
      <div class="history-info">
        <div class="history-title" title="${item.title}">${item.title}</div>
        <div class="history-meta">${item.platform}</div>
      </div>
      <button class="history-refetch" type="button">Fetch Again</button>
    `;
    card.querySelector('.history-refetch').addEventListener('click', () => {
      urlInput.value = item.url;
      urlInput.dispatchEvent(new Event('input'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      form.requestSubmit();
    });
    historyList.appendChild(card);
  });
}

clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem('streamsave_history');
  renderHistory();
});

renderHistory();
