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
const engineBadge = document.getElementById('engine-badge');
const engineStatusText = document.getElementById('engine-status-text');

// Video Details Elements
const resThumbnail = document.getElementById('res-thumbnail');
const resDurationBadge = document.getElementById('res-duration-badge');
const resShortsBadge = document.getElementById('res-shorts-badge');
const resTitle = document.getElementById('res-title');
const resUploader = document.getElementById('res-uploader');
const resDescription = document.getElementById('res-description');
const descToggleBtn = document.getElementById('desc-toggle-btn');

// Stats Elements
const statPillDuration = document.getElementById('stat-pill-duration');
const statValDuration = document.getElementById('stat-val-duration');
const statPillViews = document.getElementById('stat-pill-views');
const statValViews = document.getElementById('stat-val-views');
const statPillLikes = document.getElementById('stat-pill-likes');
const statValLikes = document.getElementById('stat-val-likes');
const statPillComments = document.getElementById('stat-pill-comments');
const statValComments = document.getElementById('stat-val-comments');

// Format Selector Elements
const formatControlsGroup = document.querySelector('.format-controls-group');
const formatSelectTrigger = document.getElementById('format-select-trigger');
const formatDropdownMenu = document.getElementById('format-dropdown-menu');
const selectedFormatText = document.getElementById('selected-format-text');
const activeTagBadge = document.getElementById('active-tag-badge');
const activeSpecText = document.getElementById('active-spec-text');
const primaryDownloadBtn = document.getElementById('primary-download-btn');

const groupVideoContainer = document.getElementById('group-video-container');
const groupVideoList = document.getElementById('group-video-list');
const groupAudioContainer = document.getElementById('group-audio-container');
const groupAudioList = document.getElementById('group-audio-list');

// Progress Card Elements
const downloadProgressNote = document.getElementById('download-progress-note');
const downloadProgressText = document.getElementById('download-progress-text');
const downloadPercentBadge = document.getElementById('download-percent-badge');
const downloadProgressBar = document.getElementById('download-progress-bar');
const downloadSizeInfo = document.getElementById('download-size-info');
const downloadSpeedInfo = document.getElementById('download-speed-info');
const progressSpinner = document.getElementById('progress-spinner');

// Footer Actions
const resetAnotherBtn = document.getElementById('reset-another-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const copyLinkText = document.getElementById('copy-link-text');

// History Elements
const historySection = document.getElementById('history-section');
const historyList = document.getElementById('history-list');
const clearHistoryBtn = document.getElementById('clear-history-btn');

let activePollTimer = null;
let currentVideoData = null;
let currentOriginalUrl = '';
let currentSelectedOption = null;
let isFetchingInfo = false;
const defaultPageTitle = document.title;

// Theme Setup (Default: Light / Clean White)
const savedTheme = localStorage.getItem('streamsave_theme') || 'light';
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
  } catch {
    setTimeout(checkEngineStatus, 4000);
  }
}
checkEngineStatus();

// Extract & normalize YouTube URL from raw input or share text
function extractYouTubeUrl(rawInput) {
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

// Toggle Clear vs Paste buttons depending on whether input has value
function syncInputActionButtons() {
  const hasValue = urlInput.value.trim().length > 0;
  clearBtn.classList.toggle('hidden', !hasValue);
  pasteBtn.classList.toggle('hidden', hasValue);
}

urlInput.addEventListener('input', () => {
  syncInputActionButtons();
  hideAlert();
});

// Auto-normalize when user pastes directly via Ctrl+V / context menu
urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    const extracted = extractYouTubeUrl(urlInput.value);
    if (extracted) {
      urlInput.value = extracted;
    }
    syncInputActionButtons();
  }, 20);
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  syncInputActionButtons();
  hideAlert();
  urlInput.focus();
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const extracted = extractYouTubeUrl(text);
      urlInput.value = extracted || text.trim();
      syncInputActionButtons();
      hideAlert();
      if (extracted && !isFetchingInfo) {
        form.requestSubmit();
      }
    }
  } catch {
    urlInput.focus();
    showAlert('Please press Ctrl+V to paste the YouTube link.');
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
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function formatDuration(sec, fallbackStr) {
  if (fallbackStr) return fallbackStr;
  if (!sec || isNaN(sec)) return '00:00';
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

// Helper to close dropdown menu
function closeFormatDropdown() {
  if (!formatDropdownMenu) return;
  formatDropdownMenu.classList.add('hidden');
  formatSelectTrigger.classList.remove('active');
  formatSelectTrigger.setAttribute('aria-expanded', 'false');
  if (formatControlsGroup) {
    formatControlsGroup.classList.remove('open');
  }
}

// Format Dropdown Toggle
formatSelectTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = formatDropdownMenu.classList.toggle('hidden');
  const isOpen = !isHidden;
  formatSelectTrigger.classList.toggle('active', isOpen);
  formatSelectTrigger.setAttribute('aria-expanded', String(isOpen));
  if (formatControlsGroup) {
    formatControlsGroup.classList.toggle('open', isOpen);
  }
  if (isOpen) {
    const activeItem = formatDropdownMenu.querySelector('.dropdown-item.selected');
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }
});

// Close dropdown when clicking outside or pressing Escape
document.addEventListener('click', (e) => {
  if (formatDropdownMenu && !formatDropdownMenu.classList.contains('hidden')) {
    if (!formatControlsGroup.contains(e.target)) {
      closeFormatDropdown();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeFormatDropdown();
  }
});

// Description "See more / See less" Toggle
descToggleBtn.addEventListener('click', () => {
  const isExpanded = resDescription.classList.toggle('expanded');
  descToggleBtn.textContent = isExpanded ? 'See less' : 'See more';
});

// Reset Another Video Button
resetAnotherBtn.addEventListener('click', () => {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
  document.title = defaultPageTitle;
  closeFormatDropdown();
  resultCard.classList.add('hidden');
  downloadProgressNote.classList.add('hidden');
  urlInput.value = '';
  syncInputActionButtons();
  hideAlert();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  urlInput.focus();
});

// Copy Video Link Button
copyLinkBtn.addEventListener('click', async () => {
  if (!currentOriginalUrl) return;
  try {
    await navigator.clipboard.writeText(currentOriginalUrl);
    copyLinkText.textContent = 'Link Copied!';
    setTimeout(() => {
      copyLinkText.textContent = 'Copy Video Link';
    }, 2000);
  } catch {
    copyLinkText.textContent = 'Copied!';
    setTimeout(() => {
      copyLinkText.textContent = 'Copy Video Link';
    }, 2000);
  }
});

// Form Submission (Fetch Video Info)
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isFetchingInfo) return;

  const rawVal = urlInput.value.trim();
  if (!rawVal) {
    showAlert('Please paste a YouTube video or Shorts link first.');
    return;
  }

  const normalizedUrl = extractYouTubeUrl(rawVal);
  if (!normalizedUrl) {
    showAlert('Please enter a valid YouTube link (e.g. https://youtu.be/... or https://youtube.com/watch?v=...).');
    return;
  }

  urlInput.value = normalizedUrl;
  syncInputActionButtons();
  hideAlert();
  closeFormatDropdown();

  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
  document.title = defaultPageTitle;
  resultCard.classList.add('hidden');
  downloadProgressNote.classList.add('hidden');
  loadingCard.classList.remove('hidden');

  isFetchingInfo = true;
  fetchBtn.disabled = true;
  fetchBtn.querySelector('.btn-text').textContent = 'Fetching...';

  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: normalizedUrl })
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Could not fetch YouTube video details.');
    }

    currentVideoData = data;
    currentOriginalUrl = normalizedUrl;
    renderResult(data, normalizedUrl);
    saveToHistory(data, normalizedUrl);
  } catch (err) {
    showAlert(err.message || 'Failed to fetch YouTube video. Please check the link and try again.');
  } finally {
    isFetchingInfo = false;
    loadingCard.classList.add('hidden');
    fetchBtn.disabled = false;
    fetchBtn.querySelector('.btn-text').textContent = 'Download';
  }
});

// Render Fetched Video Information
function renderResult(data, originalUrl) {
  const thumbUrl = data.thumbnail
    ? `/api/thumbnail?url=${encodeURIComponent(data.thumbnail)}`
    : 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=600&auto=format&fit=crop&q=80';

  resThumbnail.src = thumbUrl;
  resThumbnail.onerror = () => {
    resThumbnail.src = 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=600&auto=format&fit=crop&q=80';
  };

  const durStr = formatDuration(data.duration, data.duration_string);
  resDurationBadge.textContent = durStr;
  statValDuration.textContent = durStr;

  // Detect Shorts
  const isShort = originalUrl.includes('/shorts/') || (data.duration && data.duration <= 60);
  resShortsBadge.classList.toggle('hidden', !isShort);

  // Channel & Title
  resUploader.textContent = data.channel || data.uploader || 'YouTube Channel';
  resTitle.textContent = data.title || 'YouTube Video';

  // Description & See more toggle
  const desc = (data.description || '').trim();
  if (desc) {
    resDescription.textContent = desc;
    resDescription.classList.remove('expanded');
    descToggleBtn.textContent = 'See more';
    descToggleBtn.classList.toggle('hidden', desc.length <= 110);
  } else {
    resDescription.textContent = 'Watch and download this YouTube video in Full HD with crystal-clear audio.';
    descToggleBtn.classList.add('hidden');
  }

  // Stats Pills (Views, Likes, Comments)
  const views = formatNumber(data.view_count);
  if (views) {
    statValViews.textContent = views;
    statPillViews.classList.remove('hidden');
  } else {
    statPillViews.classList.add('hidden');
  }

  const likes = formatNumber(data.like_count);
  if (likes) {
    statValLikes.textContent = likes;
    statPillLikes.classList.remove('hidden');
  } else {
    statPillLikes.classList.add('hidden');
  }

  const comments = formatNumber(data.comment_count);
  if (comments) {
    statValComments.textContent = comments;
    statPillComments.classList.remove('hidden');
  } else {
    statPillComments.classList.add('hidden');
  }

  // Set default selection to 1080p if available, else 720p or first available option
  const options = data.options || [];
  const defaultOpt =
    options.find(o => o.quality === '1080p' || o.id === 'height_1080') ||
    options.find(o => o.quality === '720p' || o.id === 'height_720') ||
    options[0] ||
    null;

  currentSelectedOption = defaultOpt;
  updateSelectedDisplay();
  closeFormatDropdown();
  renderOptionsList();

  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Update the Selected Format Trigger Bar and Active Highlight Action Card
function updateSelectedDisplay() {
  if (!currentSelectedOption) return;

  const opt = currentSelectedOption;
  const sizeText = opt.filesize ? formatBytes(opt.filesize) : '';
  const sizePart = sizeText ? ` · ${sizeText}` : '';
  const extPart = (opt.ext || 'MP4').toUpperCase();

  // Top Trigger Bar text: e.g. "1080p · MP4 · 274.74 MB"
  selectedFormatText.textContent = `${opt.label || opt.quality}${sizePart}`;

  // Active Highlight Card meta:
  // e.g. [Needs processing] MP4 · FHD · 274.74 MB [↓ Download]
  const badgeLabel = opt.badge || (opt.type === 'audio' ? 'Audio' : (opt.quality === '1080p' ? 'Needs processing' : 'HD'));
  activeTagBadge.textContent = badgeLabel;
  activeTagBadge.className = `status-badge ${opt.type === 'audio' ? 'audio' : ''}`;

  const resTag = opt.resolutionTag || (opt.quality === '1080p' ? 'FHD' : (opt.quality === '720p' ? 'HD' : opt.quality));
  if (opt.type === 'audio') {
    activeSpecText.textContent = `${extPart} · ${opt.quality || opt.resolutionTag || 'Audio'}${sizePart}`;
  } else {
    activeSpecText.textContent = `${extPart} · ${resTag}${sizePart}`;
  }

  // Connect Primary Download Button
  primaryDownloadBtn.onclick = () => {
    triggerDownloadForOption(opt);
  };
}

// Render dynamic format options list grouped by Video and Audio
function renderOptionsList() {
  if (!currentVideoData || !currentVideoData.options) return;

  groupVideoList.innerHTML = '';
  groupAudioList.innerHTML = '';

  const createOptionItem = (opt) => {
    const isSelected = currentSelectedOption && currentSelectedOption.id === opt.id;
    const sizeStr = opt.filesize ? formatBytes(opt.filesize) : '';

    const item = document.createElement('div');
    item.className = `dropdown-item ${isSelected ? 'selected' : ''}`;
    item.innerHTML = `
      <span>${opt.label}${sizeStr ? ` · ${sizeStr}` : ''}</span>
      <span class="item-sub-tag">${opt.resolutionTag || opt.quality || ''}</span>
    `;

    item.addEventListener('click', () => {
      currentSelectedOption = opt;
      updateSelectedDisplay();
      renderOptionsList();
      closeFormatDropdown();
    });

    return item;
  };

  // 1. Video Options
  const videoOpts = currentVideoData.options.filter(o => o.type === 'video');
  if (groupVideoContainer) {
    groupVideoContainer.classList.toggle('hidden', videoOpts.length === 0);
  }
  videoOpts.forEach(opt => {
    groupVideoList.appendChild(createOptionItem(opt));
  });

  // 2. Audio Options
  const audioOpts = currentVideoData.options.filter(o => o.type === 'audio');
  if (groupAudioContainer) {
    groupAudioContainer.classList.toggle('hidden', audioOpts.length === 0);
  }
  audioOpts.forEach(opt => {
    groupAudioList.appendChild(createOptionItem(opt));
  });
}

// Trigger Download for a specific option
function triggerDownloadForOption(opt) {
  if (!currentVideoData || !currentOriginalUrl) return;

  startTrackedDownload({
    url: currentOriginalUrl,
    format: opt.id,
    type: opt.type,
    title: currentVideoData.title,
    label: opt.label,
    ext: opt.ext,
    directUrl: opt.directUrl || null,
    isServerless: !!currentVideoData.isServerless
  });
}

// Download Process with Live Progress
async function startTrackedDownload({ url, format, type, title, label, ext, directUrl, isServerless }) {
  hideAlert();
  closeFormatDropdown();

  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }

  primaryDownloadBtn.disabled = true;
  primaryDownloadBtn.querySelector('.btn-label').textContent = 'Preparing...';

  // Show & Reset Progress Card
  progressSpinner.classList.remove('hidden');
  downloadProgressNote.classList.remove('hidden');
  downloadProgressBar.style.width = '2%';
  downloadPercentBadge.textContent = '0%';
  downloadProgressText.textContent = `Connecting to stream (${label})...`;
  downloadSizeInfo.textContent = 'Initializing media download...';
  downloadSpeedInfo.textContent = '';
  downloadProgressNote.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Cloud / Direct Stream Download (Single Request with ReadableStream byte tracking)
  if (isServerless || directUrl) {
    try {
      const targetEndpoint = directUrl
        ? `/api/proxy-download?directUrl=${encodeURIComponent(directUrl)}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent(ext || 'mp4')}`
        : `/api/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}&type=${encodeURIComponent(type)}&title=${encodeURIComponent(title)}`;

      let fakePct = 5;
      activePollTimer = setInterval(() => {
        if (fakePct < 90) {
          fakePct += Math.max(1, Math.round((92 - fakePct) * 0.1));
          downloadProgressBar.style.width = `${fakePct}%`;
          downloadPercentBadge.textContent = `${fakePct}%`;
          downloadProgressText.textContent = `Processing YouTube Stream... ${fakePct}%`;
          primaryDownloadBtn.querySelector('.btn-label').textContent = `${fakePct}%`;
          document.title = `(${fakePct}%) Downloading — SnapVids`;
        }
      }, 450);

      const response = await fetch(targetEndpoint);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || 'Failed to download YouTube video.');
      }

      const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
      let blob;

      if (response.body && contentLength > 0) {
        clearInterval(activePollTimer);
        activePollTimer = null;

        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedLength += value.length;
          const pct = Math.min(99, Math.round((receivedLength / contentLength) * 100));
          downloadProgressBar.style.width = `${pct}%`;
          downloadPercentBadge.textContent = `${pct}%`;
          downloadProgressText.textContent = `Downloading Stream... ${pct}%`;
          downloadSizeInfo.textContent = `${formatBytes(receivedLength)} / ${formatBytes(contentLength)}`;
          primaryDownloadBtn.querySelector('.btn-label').textContent = `${pct}%`;
          document.title = `(${pct}%) Downloading — SnapVids`;
        }
        blob = new Blob(chunks);
      } else {
        blob = await response.blob();
        if (activePollTimer) {
          clearInterval(activePollTimer);
          activePollTimer = null;
        }
      }

      document.title = defaultPageTitle;
      downloadProgressBar.style.width = '100%';
      downloadPercentBadge.textContent = '100%';
      progressSpinner.classList.add('hidden');
      downloadProgressText.textContent = '✅ 100% Complete! File saved to browser downloads.';
      downloadSizeInfo.textContent = `Size: ${formatBytes(blob.size)}`;
      downloadSpeedInfo.textContent = 'Saved to Downloads folder';
      primaryDownloadBtn.disabled = false;
      primaryDownloadBtn.querySelector('.btn-label').textContent = 'Download';

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const safeName = (title || 'youtube_video').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 90) || 'youtube_video';
      const fileExt = ext || (type === 'audio' ? 'm4a' : 'mp4');
      a.download = `${safeName}.${fileExt}`;
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
      primaryDownloadBtn.disabled = false;
      primaryDownloadBtn.querySelector('.btn-label').textContent = 'Download';
    }
    return;
  }

  // Local Tracked Download with real-time FFmpeg & yt-dlp progress
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
        primaryDownloadBtn.querySelector('.btn-label').textContent = prog.status === 'merging' ? 'Merging...' : `${pct}%`;
        document.title = `(${pct}%) Downloading — SnapVids`;

        if (prog.totalSize) downloadSizeInfo.textContent = `Total Size: ${prog.totalSize}`;
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
          downloadProgressText.textContent = '✅ 100% Complete! File saved to browser downloads.';
          downloadSpeedInfo.textContent = 'Saved to your Downloads folder';
          primaryDownloadBtn.disabled = false;
          primaryDownloadBtn.querySelector('.btn-label').textContent = 'Download';

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
          primaryDownloadBtn.disabled = false;
          primaryDownloadBtn.querySelector('.btn-label').textContent = 'Download';
        }
      } catch {
        // Ignore transient poll hiccup
      }
    }, 350);
  } catch (err) {
    document.title = defaultPageTitle;
    downloadProgressNote.classList.add('hidden');
    showAlert(err.message || 'Failed to start download.');
    primaryDownloadBtn.disabled = false;
    primaryDownloadBtn.querySelector('.btn-label').textContent = 'Download';
  }
}

// Recent Downloads History (LocalStorage)
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
        <div class="history-meta">YouTube</div>
      </div>
      <button class="history-refetch" type="button">Fetch Again</button>
    `;
    card.querySelector('.history-refetch').addEventListener('click', () => {
      urlInput.value = item.url;
      syncInputActionButtons();
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

syncInputActionButtons();
renderHistory();
