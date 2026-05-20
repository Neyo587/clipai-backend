const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();

app.use((req, res, next) => {
  const allowed = [
    'https://clipai-ten.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://clipai-ten.vercel.app');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-filename,x-requested-with,Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clipaidownloader.html')));

const YTDLP = path.join(__dirname, 'yt-dlp');
const FFMPEG = path.join(__dirname, 'ffmpeg');
const COOKIES_FILE = '/tmp/yt-cookies.txt';
const DOWNLOAD_DIR = '/tmp/clipai';
const UPLOAD_DIR = '/tmp/clipai-uploads';

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function getProxyUrl() {
  const raw = String(process.env.PROXY_URL || '').trim();
  if (!raw || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'false') return '';
  return raw;
}

function ytArgList(extra = []) {
  const args = [
    '--extractor-args', 'youtube:player_client=android_embedded,ios,android,web',
    '--no-warnings',
    '--format-sort', 'ext:mp4:m4a',
    '--retries', '3',
    '--fragment-retries', '3'
  ];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  const proxy = getProxyUrl();
  if (proxy) args.push('--proxy', proxy);
  return args.concat(extra);
}

function describeProxyProblem(stderr) {
  const text = String(stderr || '');
  if (/407|Proxy Authentication Required|Unable to connect to proxy|Tunnel connection failed/i.test(text)) {
    return 'Proxy authentication failed. In Render, remove PROXY_URL if you do not need a proxy, or set it with credentials like http://USER:PASS@HOST:PORT.';
  }
  return '';
}

function describeCookieProblem(stderr) {
  const text = String(stderr || '');
  if (/Sign in to confirm.*not a bot|Use --cookies-from-browser|Use --cookies|authentication/i.test(text)) {
    return 'YouTube is asking this Render server to prove it is not a bot. Add fresh YouTube cookies in Render as YT_COOKIES_B64 or YT_COOKIES, then redeploy.';
  }
  return '';
}

function compactProcessError(stderr, fallback) {
  const proxyProblem = describeProxyProblem(stderr);
  if (proxyProblem) return proxyProblem;
  const cookieProblem = describeCookieProblem(stderr);
  if (cookieProblem) return cookieProblem;
  const lines = String(stderr || '').split('\n').map(line => line.trim()).filter(Boolean);
  const important = lines.filter(line => /error|failed|unable|forbidden|sign in|confirm|private|copyright/i.test(line));
  return (important.length ? important.join(' | ') : lines.slice(-4).join(' | ') || fallback).slice(0, 700);
}

function normalizeCookieContent(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('[')) {
    const cookies = JSON.parse(text);
    let cookieContent = '# Netscape HTTP Cookie File\n';
    cookies.forEach(c => {
      const domain = c.domain && c.domain.startsWith('.') ? c.domain : '.' + c.domain;
      const flag = c.domain && c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = Math.round(c.expirationDate || c.expiration_date || c.expires || 0);
      cookieContent += `${domain}\t${flag}\t${c.path || '/'}\t${secure}\t${expiry}\t${c.name}\t${c.value}\n`;
    });
    return cookieContent;
  }
  return text.replace(/\\n/g, '\n');
}

function writeYoutubeCookiesFromEnv() {
  const raw =
    process.env.YT_COOKIES_B64
      ? Buffer.from(process.env.YT_COOKIES_B64.trim(), 'base64').toString('utf8')
      : (process.env.YT_COOKIES || process.env.YOUTUBE_COOKIES || '');

  if (!raw) return false;
  const cookieContent = normalizeCookieContent(raw);
  if (!cookieContent.trim()) return false;
  fs.writeFileSync(COOKIES_FILE, cookieContent);
  return true;
}

function publicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function downloadFile(url, dest, callback) {
  const file = fs.createWriteStream(dest);
  const protocol = url.startsWith('https') ? https : http;
  protocol.get(url, (res) => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      file.close();
      try { fs.unlinkSync(dest); } catch (e) {}
      downloadFile(res.headers.location, dest, callback);
      return;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      file.close();
      try { fs.unlinkSync(dest); } catch (e) {}
      callback(new Error(`Download failed with status ${res.statusCode}`));
      return;
    }
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      callback(null);
    });
  }).on('error', (err) => {
    try { fs.unlinkSync(dest); } catch (e) {}
    callback(err);
  });
}

function setup(callback) {
  callback();

  try {
    if (writeYoutubeCookiesFromEnv()) {
      console.log('YouTube cookies written');
    } else {
      console.log('No YouTube cookies configured');
    }
  } catch (e) {
    console.error('Cookie conversion failed:', e.message);
  }

  if (fs.existsSync(YTDLP)) {
    try { fs.unlinkSync(YTDLP); } catch (e) {}
  }
  console.log('Downloading yt-dlp...');
  downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', YTDLP, (err) => {
    if (err) console.error('yt-dlp failed:', err.message);
    else {
      fs.chmodSync(YTDLP, '755');
      console.log('yt-dlp ready');
    }
  });

  if (!fs.existsSync(FFMPEG)) {
    console.log('Downloading ffmpeg...');
    downloadFile('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64', FFMPEG, (err) => {
      if (err) console.error('ffmpeg failed:', err.message);
      else {
        fs.chmodSync(FFMPEG, '755');
        console.log('ffmpeg ready');
      }
    });
  } else {
    console.log('ffmpeg already exists');
  }
}

function fetchWithBuffer(url, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (options.body) reqOptions.headers['content-length'] = options.body.length;
    const req = protocol.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function waitForFile(filePath, timeout = 60000) {
  return new Promise((resolve) => {
    if (fs.existsSync(filePath)) return resolve(true);
    let waited = 0;
    const interval = setInterval(() => {
      waited += 2000;
      if (fs.existsSync(filePath)) {
        clearInterval(interval);
        resolve(true);
      } else if (waited >= timeout) {
        clearInterval(interval);
        resolve(false);
      }
    }, 2000);
  });
}

function streamVideoFile(req, res, filePath, contentType = 'video/mp4') {
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= stat.size || end >= stat.size) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
}

function runYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, {
      timeout: options.timeout || 600000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 100
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, {
      timeout: options.timeout || 900000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 120
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseDurationFromFfmpeg(stderr) {
  const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function probeMediaDuration(filePath) {
  try {
    await runFfmpeg(['-hide_banner', '-i', filePath], { timeout: 30000, maxBuffer: 1024 * 1024 * 5 });
    return 0;
  } catch (err) {
    return parseDurationFromFfmpeg(err.stderr);
  }
}

function pickCompilationStart(duration, segmentDuration, style) {
  const maxStart = Math.max(0, duration - segmentDuration - 2);
  const ratios = {
    funniest: 0.25,
    controversial: 0.18,
    educational: 0.10,
    motivational: 0.35,
    documentary: 0.04
  };
  const ratio = ratios[style] === undefined ? 0.15 : ratios[style];
  return Math.max(0, Math.min(maxStart, Math.round(duration * ratio)));
}

function concatListLine(filePath) {
  return `file '${String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

const compilationJobs = new Map();

function updateCompilationJob(jobId, patch) {
  const job = compilationJobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function processCompilationJob(jobId) {
  const job = compilationJobs.get(jobId);
  if (!job) return;
  const tempPaths = [];

  try {
    updateCompilationJob(jobId, { status: 'running', phase: 'Preparing renderer', progress: 3 });

    const readyYt = await waitForFile(YTDLP);
    const readyFfmpeg = await waitForFile(FFMPEG);
    if (!readyYt || !readyFfmpeg) throw new Error('Downloader is still starting. Try again in a minute.');

    const sourcePaths = [];
    const segmentPaths = [];
    const targetSeconds = Math.max(120, Math.min(45 * 60, Number(job.targetMinutes || 10) * 60));
    const perSourceTarget = Math.max(20, Math.min(10 * 60, Math.round(targetSeconds / job.links.length)));

    for (let i = 0; i < job.links.length; i++) {
      const link = job.links[i];
      const sourcePath = path.join(UPLOAD_DIR, `${jobId}_source_${i}.mp4`);
      sourcePaths.push(sourcePath);
      tempPaths.push(sourcePath);
      updateCompilationJob(jobId, {
        phase: `Downloading source ${i + 1} of ${job.links.length}`,
        progress: Math.round(5 + (i / job.links.length) * 35)
      });

      const args = ytArgList([
        '--ffmpeg-location', FFMPEG,
        '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', sourcePath,
        link
      ]);
      await runYtDlp(args, { timeout: 900000, maxBuffer: 1024 * 1024 * 220 });
      if (!fs.existsSync(sourcePath)) throw new Error(`Source ${i + 1} could not be downloaded.`);
    }

    for (let i = 0; i < sourcePaths.length; i++) {
      const sourcePath = sourcePaths[i];
      updateCompilationJob(jobId, {
        phase: `Cutting segment ${i + 1} of ${sourcePaths.length}`,
        progress: Math.round(45 + (i / sourcePaths.length) * 35)
      });

      const duration = await probeMediaDuration(sourcePath);
      const segmentDuration = duration ? Math.min(perSourceTarget, Math.max(15, duration - 2)) : perSourceTarget;
      const start = duration ? pickCompilationStart(duration, segmentDuration, job.style) : 0;
      const segmentPath = path.join(DOWNLOAD_DIR, `${jobId}_segment_${i}.mp4`);
      segmentPaths.push(segmentPath);
      tempPaths.push(segmentPath);

      await runFfmpeg([
        '-y',
        '-ss', String(start),
        '-t', String(segmentDuration),
        '-i', sourcePath,
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
        '-r', '30',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '28',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-movflags', '+faststart',
        '-threads', '1',
        segmentPath
      ], { timeout: 900000, maxBuffer: 1024 * 1024 * 200 });
    }

    updateCompilationJob(jobId, { phase: 'Joining final compilation', progress: 86 });
    const listPath = path.join(DOWNLOAD_DIR, `${jobId}_concat.txt`);
    fs.writeFileSync(listPath, segmentPaths.map(concatListLine).join('\n'), 'utf8');
    tempPaths.push(listPath);

    const outputPath = path.join(DOWNLOAD_DIR, `${jobId}_compilation.mp4`);
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath
    ], { timeout: 900000, maxBuffer: 1024 * 1024 * 200 });

    if (!fs.existsSync(outputPath)) throw new Error('Final compilation was not created.');
    const stat = fs.statSync(outputPath);
    updateCompilationJob(jobId, {
      status: 'completed',
      phase: 'Ready to download',
      progress: 100,
      outputPath,
      size: stat.size,
      downloadUrl: `/api/compilation/download/${jobId}`
    });

    tempPaths
      .filter(p => p !== outputPath)
      .forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  } catch (err) {
    const stderr = err.stderr || '';
    updateCompilationJob(jobId, {
      status: 'failed',
      phase: 'Failed',
      progress: 100,
      error: compactProcessError(stderr, err.message)
    });
    tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  }
}

app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ message: 'No URL provided' });

  const ready = await waitForFile(YTDLP);
  if (!ready) return res.status(503).json({ message: 'Server still starting, please wait 30 seconds and try again.' });

  try {
    const args = ytArgList(['--no-playlist', '--print', '%(title)s|||%(duration_string)s|||%(id)s', url]);
    const { stdout } = await runYtDlp(args, { timeout: 60000 });
    if (!stdout.trim()) return res.status(500).json({ message: 'Could not fetch video info' });
    const parts = stdout.trim().split('|||');
    const videoId = parts[2] || '';
    res.json({
      title: parts[0] || 'Video',
      duration: parts[1] || '',
      thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null,
      videoId
    });
  } catch (err) {
    res.status(500).json({ message: compactProcessError(err.stderr, 'Could not fetch video info'), error: compactProcessError(err.stderr, err.message) });
  }
});

app.get('/api/test-yt', async (req, res) => {
  const ready = await waitForFile(YTDLP, 10000);
  if (!ready) return res.status(503).json({ success: false, error: 'yt-dlp is not ready yet' });

  try {
    const args = ytArgList(['--print', '%(title)s', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
    const { stdout, stderr } = await runYtDlp(args, { timeout: 30000 });
    res.json({
      proxy_configured: getProxyUrl() ? 'YES' : 'NO',
      cookies_configured: fs.existsSync(COOKIES_FILE) ? 'YES' : 'NO',
      success: !!stdout.trim(),
      stdout: stdout.trim(),
      stderr: stderr.substring(0, 300),
      error: null
    });
  } catch (err) {
    res.json({
      proxy_configured: getProxyUrl() ? 'YES' : 'NO',
      cookies_configured: fs.existsSync(COOKIES_FILE) ? 'YES' : 'NO',
      success: false,
      stdout: String(err.stdout || '').trim(),
      stderr: String(err.stderr || '').substring(0, 500),
      error: compactProcessError(err.stderr, err.message)
    });
  }
});

app.get('/api/download', async (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).send('No URL');

  const ready = await waitForFile(YTDLP);
  if (!ready) return res.status(503).json({ message: 'Server still starting, try again in 30 seconds.' });

  const filename = `clipai_${Date.now()}`;
  const outputPath = path.join(DOWNLOAD_DIR, filename + (format === 'mp3' ? '.mp3' : '.mp4'));

  try {
    let args;
    let dlFilename;
    let contentType;
    if (format === 'mp3') {
      const bitrate = String(quality || '192').replace(/[^\d]/g, '') || '192';
      dlFilename = 'audio.mp3';
      contentType = 'audio/mpeg';
      args = ytArgList(['--ffmpeg-location', FFMPEG, '-x', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`, '-o', outputPath, url]);
    } else {
      const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
      const h = heights[quality] || 720;
      dlFilename = 'video.mp4';
      contentType = 'video/mp4';
      args = ytArgList(['--ffmpeg-location', FFMPEG, '-f', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]`, '--merge-output-format', 'mp4', '-o', outputPath, url]);
    }

    await runYtDlp(args, { timeout: 600000, maxBuffer: 1024 * 1024 * 120 });
    if (!fs.existsSync(outputPath)) return res.status(500).json({ message: 'File not created' });
    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Disposition', `attachment; filename="${dlFilename}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => setTimeout(() => { try { fs.unlinkSync(outputPath); } catch (e) {} }, 5000));
  } catch (err) {
    res.status(500).json({ message: 'Conversion failed', error: compactProcessError(err.stderr, err.message) });
  }
});

app.post('/api/youtube-upload', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const ready = await waitForFile(YTDLP);
  if (!ready) return res.status(503).json({ error: 'yt-dlp not ready, please try again.' });

  const localFileId = `yt_${Date.now()}`;
  const outputPath = path.join(UPLOAD_DIR, localFileId + '.mp4');
  const previewUrl = `${publicBaseUrl(req)}/api/serve-upload/${localFileId}`;

  try {
    const args = ytArgList([
      '--ffmpeg-location', FFMPEG,
      '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      url
    ]);
    console.log('Downloading YouTube import with proxy:', getProxyUrl() ? 'yes' : 'no');
    await runYtDlp(args, { timeout: 900000, maxBuffer: 1024 * 1024 * 220 });

    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'Downloaded file not found' });
    console.log('YouTube downloaded, size:', fs.statSync(outputPath).size);

    const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
    if (!ASSEMBLYAI_KEY) return res.json({ localFileId, uploadUrl: previewUrl, previewUrl, videoUrl: previewUrl });

    try {
      const fileData = fs.readFileSync(outputPath);
      const uploadRes = await fetchWithBuffer('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { authorization: ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
        body: fileData
      });
      const uploadData = JSON.parse(uploadRes);
      res.json({ localFileId, uploadUrl: uploadData.upload_url || previewUrl, previewUrl, videoUrl: previewUrl });
    } catch (uploadErr) {
      console.error('AssemblyAI upload error:', uploadErr.message);
      res.json({ localFileId, uploadUrl: previewUrl, previewUrl, videoUrl: previewUrl });
    }
  } catch (err) {
    res.status(500).json({ error: `YouTube download failed: ${compactProcessError(err.stderr, err.message)}` });
  }
});

app.post('/api/compilation/start', async (req, res) => {
  const body = req.body || {};
  const links = Array.isArray(body.links)
    ? body.links.map(link => String(link || '').trim()).filter(Boolean).filter((link, index, arr) => arr.indexOf(link) === index)
    : [];
  if (links.length < 2) return res.status(400).json({ error: 'At least two YouTube links are required.' });
  if (links.length > 8) return res.status(400).json({ error: 'Use 2 to 8 links for this first renderer version.' });
  const invalid = links.filter(link => !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//i.test(link));
  if (invalid.length) return res.status(400).json({ error: 'Only YouTube links are supported right now.' });

  const jobId = `comp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId,
    status: 'queued',
    phase: 'Queued',
    progress: 0,
    links,
    style: String(body.style || 'funniest'),
    targetMinutes: Math.max(2, Math.min(45, Number(body.targetMinutes) || 10)),
    brief: String(body.brief || '').slice(0, 500),
    plan: body.plan || null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  compilationJobs.set(jobId, job);
  setTimeout(() => processCompilationJob(jobId), 50);

  res.status(202).json({
    jobId,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    statusUrl: `${publicBaseUrl(req)}/api/compilation/status/${jobId}`
  });
});

app.get('/api/compilation/status/:id', (req, res) => {
  const job = compilationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Compilation job not found. Jobs are temporary, so start a new build if the server restarted.' });
  res.json({
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    error: job.error || null,
    size: job.size || 0,
    downloadUrl: job.status === 'completed' ? `${publicBaseUrl(req)}/api/compilation/download/${job.id}` : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
});

app.get('/api/compilation/download/:id', (req, res) => {
  const job = compilationJobs.get(req.params.id);
  if (!job || job.status !== 'completed' || !job.outputPath) return res.status(404).json({ error: 'Compilation is not ready.' });
  res.setHeader('Content-Disposition', 'attachment; filename="clipai-compilation.mp4"');
  streamVideoFile(req, res, job.outputPath);
});

app.get('/api/serve-upload/:id', (req, res) => {
  streamVideoFile(req, res, path.join(UPLOAD_DIR, req.params.id + '.mp4'));
});

app.post('/api/upload-local', async (req, res) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || 'upload.mp4');
  const localFileId = `upload_${Date.now()}`;
  const ext = path.extname(filename) || '.mp4';
  const outputPath = path.join(UPLOAD_DIR, localFileId + ext);
  const previewUrl = `${publicBaseUrl(req)}/api/serve-upload-raw/${localFileId}${ext}`;

  const writeStream = fs.createWriteStream(outputPath);
  req.pipe(writeStream);

  writeStream.on('finish', async () => {
    const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
    if (!ASSEMBLYAI_KEY) return res.json({ localFileId, uploadUrl: previewUrl, previewUrl, videoUrl: previewUrl });
    try {
      const fileData = fs.readFileSync(outputPath);
      const uploadRes = await fetchWithBuffer('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { authorization: ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' },
        body: fileData
      });
      const uploadData = JSON.parse(uploadRes);
      res.json({ localFileId, uploadUrl: uploadData.upload_url || previewUrl, previewUrl, videoUrl: previewUrl });
    } catch (err) {
      console.error('AssemblyAI upload error:', err.message);
      res.json({ localFileId, uploadUrl: previewUrl, previewUrl, videoUrl: previewUrl });
    }
  });
  writeStream.on('error', () => res.status(500).json({ error: 'Failed to save file' }));
});

app.get('/api/serve-upload-raw/:filename', (req, res) => {
  streamVideoFile(req, res, path.join(UPLOAD_DIR, req.params.filename));
});

app.post('/api/cut-clip', async (req, res) => {
  const { localFileId, startMs, endMs, clipTitle } = req.body || {};
  if (!localFileId) return res.status(400).json({ error: 'localFileId required' });
  if (!fs.existsSync(FFMPEG)) return res.status(503).json({ error: 'ffmpeg is still starting, please try again.' });

  const files = fs.readdirSync(UPLOAD_DIR);
  const match = files.find(f => f.startsWith(localFileId));
  if (!match) return res.status(404).json({ error: 'Source file not found. Please re-upload.' });

  const inputPath = path.join(UPLOAD_DIR, match);
  const outputPath = path.join(DOWNLOAD_DIR, `clip_${Date.now()}.mp4`);
  const startSec = (Number(startMs || 0) / 1000).toFixed(3);
  const durationSec = ((Number(endMs || 0) - Number(startMs || 0)) / 1000).toFixed(3);
  const args = [
    '-y',
    '-ss', startSec,
    '-t', durationSec,
    '-i', inputPath,
    '-vf', 'scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2:black',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '30',
    '-tune', 'fastdecode',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ac', '1',
    '-movflags', '+faststart',
    '-threads', '1',
    outputPath
  ];

  console.log('Cutting clip:', clipTitle);
  execFile(FFMPEG, args, { maxBuffer: 1024 * 1024 * 500, timeout: 300000 }, (err, stdout, stderr) => {
    if (err || !fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Cut failed: ' + compactProcessError(stderr, err ? err.message : 'Output missing') });
    }
    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="clip.mp4"');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => setTimeout(() => { try { fs.unlinkSync(outputPath); } catch (e) {} }, 5000));
  });
});

setup(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Clipai downloader running on port ' + PORT));
});
