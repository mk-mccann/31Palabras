// Episodes may be one file or separate video and audio files, in containers a
// browser can't always open. Each is remuxed into an MP4 (stream copy, about a
// second) in a small on-disk LRU cache. Only audio browsers can't play is
// re-encoded; video in a codec they can't play is refused.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { LANGUAGES } from './languages.js';

const run = promisify(execFile);
const COPYABLE_VIDEO = new Set(['h264', 'hevc', 'av1', 'vp9']);
const COPYABLE_AUDIO = new Set(['aac', 'opus', 'mp3']);
const inFlight = new Map();

export class MediaProblem extends Error {}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
}

export async function mediaDuration(file) {
  try {
    const seconds = Number((await probe(file)).format?.duration);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

const isVideo = (s) => s.codec_type === 'video' && !s.disposition?.attached_pic; // not cover art
const isAudio = (s) => s.codec_type === 'audio';

// Prefers one file holding both streams, and the audio track in the language
// being studied when a file has several.
export function planStreams(probes, audioTags = []) {
  const both = probes.find((p) => p.streams.some(isVideo) && p.streams.some(isAudio));
  const videoFile = both ?? probes.find((p) => p.streams.some(isVideo));
  const audioFile = both ?? probes.find((p) => p.streams.some(isAudio));
  if (!videoFile) throw new MediaProblem("This episode's folder has no video file.");
  const video = videoFile.streams.find(isVideo);
  if (!COPYABLE_VIDEO.has(video.codec_name)) {
    throw new MediaProblem(`This video uses ${video.codec_name}, which browsers can't play. Convert it to H.264 first.`);
  }
  const tracks = audioFile ? audioFile.streams.filter(isAudio) : [];
  const audio = tracks.find((s) => audioTags.includes(s.tags?.language?.toLowerCase()))
    ?? tracks.find((s) => s.disposition?.default)
    ?? tracks[0];
  return { videoFile: videoFile.file, video, audioFile: audioFile?.file, audio };
}

export function ffmpegArgs({ videoFile, video, audioFile, audio }, output) {
  const separate = audio && audioFile !== videoFile;
  const args = ['-v', 'error', '-y', '-i', videoFile, ...(separate ? ['-i', audioFile] : []), '-map', `0:${video.index}`];
  if (audio) args.push('-map', `${separate ? 1 : 0}:${audio.index}`);
  args.push('-c:v', 'copy', ...(video.codec_name === 'hevc' ? ['-tag:v', 'hvc1'] : []));
  if (audio) args.push(...(COPYABLE_AUDIO.has(audio.codec_name) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
  return [...args, '-movflags', '+faststart', '-f', 'mp4', output];
}

async function runFfmpeg(ep, target) {
  const partial = `${target}.partial`;
  const probes = await Promise.all(ep.media.map(async (file) => ({ file, streams: (await probe(file)).streams ?? [] })));
  const args = ffmpegArgs(planStreams(probes, LANGUAGES[ep.language].audioTags), partial);
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        fs.rmSync(partial, { force: true });
        reject(new Error(`ffmpeg failed: ${errors.slice(0, 400)}`));
        return;
      }
      fs.renameSync(partial, target);
      resolve();
    });
  });
}

function evict(cacheDir, keep, current) {
  const cached = fs.readdirSync(cacheDir)
    .filter((name) => name.endsWith('.mp4'))
    .map((name) => ({ file: path.join(cacheDir, name), used: fs.statSync(path.join(cacheDir, name)).mtimeMs }))
    .sort((a, b) => b.used - a.used);
  for (const { file } of cached.slice(keep)) {
    if (file !== current) fs.rmSync(file, { force: true });
  }
}

export async function episodeFile(ep, cacheDir, keep) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${ep.id}.mp4`);
  if (fs.existsSync(target)) {
    const now = new Date();
    fs.utimesSync(target, now, now);
    return target;
  }
  if (!inFlight.has(ep.id)) {
    inFlight.set(ep.id, runFfmpeg(ep, target).finally(() => inFlight.delete(ep.id)));
  }
  await inFlight.get(ep.id);
  evict(cacheDir, keep, target);
  return target;
}

export function sendFileWithRange(req, res, file) {
  const { size } = fs.statSync(file);
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const match = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  const stream = fs.createReadStream(file, { start, end });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
