const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const YTDLP = 'yt-dlp';
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clipaidownloader.html')));

app.post('/api/convert', (req, res) => {
  const { url, format, quality } = req.body;
  if (!url) return res.status(400).json({ message: 'No URL provided' });

  const outputDir = path.join(__dirname, 'downloads');
  const filename = `download_${Date.now()}`;
  let outputPath, cmd;

  if (format === 'mp3') {
    const bitrate = quality ? quality.replace(' kbps', '') : '192';
    outputPath = path.join(outputDir, filename + '.mp3');
    cmd = `"${YTDLP}" -x --audio-format mp3 --audio-quality ${bitrate}K -o "${outputPath}" "${url}"`;
  } else {
    const heights = { '480p': 480, '720p': 720, '1080p': 1080, '4K': 2160 };
    const h = heights[quality] || 720;
    outputPath = path.join(outputDir, filename + '.mp4');
    cmd = `"${YTDLP}" -f "bestvideo[height<=${h}]+bestaudio/best[height<=${h}]" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
  }

  exec(`"${YTDLP}" --print "%(title)s|||%(thumbnail)s|||%(duration_string)s" "${url}"`, (err, stdout) => {
    const parts = (stdout || '').trim().split('|||');
    const title = parts[0] || 'Video';
    const thumbnail = parts[1] || null;
    const duration = parts[2] || '';

    exec(cmd, (err2, stdout2, stderr2) => {
      if (err2) {
        console.error('Conversion error:', stderr2);
        return res.status(500).json({ message: 'Conversion failed: ' + stderr2 });
      }
      const downloadUrl = `/downloads/${path.basename(outputPath)}`;
      res.json({ title, thumbnail, duration, downloadUrl });
      setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e){} }, 30 * 60 * 1000);
    });
  });
});

app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
app.listen(3000, () => console.log('✅ Clipai running at http://localhost:3000'));
