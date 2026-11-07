import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ffmpegArgs, MediaProblem, planStreams } from '../lib/media.js';

const video = (index, codec = 'h264', extra = {}) => ({ index, codec_type: 'video', codec_name: codec, ...extra });
const audio = (index, language, codec = 'aac', extra = {}) => ({ index, codec_type: 'audio', codec_name: codec, tags: { language }, ...extra });

test('separate video and audio files are paired', () => {
  const plan = planStreams([{ file: 'a.webm', streams: [audio(0, 'eng', 'opus')] }, { file: 'v.mp4', streams: [video(0, 'av1')] }]);
  assert.equal(plan.videoFile, 'v.mp4');
  assert.equal(plan.audioFile, 'a.webm');
  const args = ffmpegArgs(plan, 'out.mp4');
  assert.deepEqual(args.slice(3, 11), ['-i', 'v.mp4', '-i', 'a.webm', '-map', '0:0', '-map', '1:0']);
  assert.ok(args.includes('copy'));
  assert.ok(!args.includes('aac'));
});

test('a single file is used alone, with the studied language chosen', () => {
  const plan = planStreams([{ file: 'x.mkv', streams: [video(0), audio(1, 'eng', 'aac', { disposition: { default: 1 } }), audio(2, 'fre')] }], ['fra', 'fre', 'fr']);
  assert.equal(plan.audio.index, 2);
  const args = ffmpegArgs(plan, 'out.mp4');
  assert.deepEqual(args.slice(3, 9), ['-i', 'x.mkv', '-map', '0:0', '-map', '0:2']);
});

test('falls back to the default audio track when none matches the language', () => {
  const plan = planStreams([{ file: 'x.mkv', streams: [video(0), audio(1, 'eng'), audio(2, 'ita', 'aac', { disposition: { default: 1 } })] }], ['spa', 'es']);
  assert.equal(plan.audio.index, 2);
});

test('audio browsers cannot play is re-encoded, and cover art is not video', () => {
  const plan = planStreams([{ file: 'x.mkv', streams: [video(0, 'mjpeg', { disposition: { attached_pic: 1 } }), video(1), audio(2, 'spa', 'ac3')] }]);
  assert.equal(plan.video.index, 1);
  const args = ffmpegArgs(plan, 'out.mp4');
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'aac']);
});

test('video browsers cannot play is refused with a clear reason', () => {
  assert.throws(() => planStreams([{ file: 'x.avi', streams: [video(0, 'mpeg4'), audio(1, 'spa')] }]), MediaProblem);
  assert.throws(() => planStreams([{ file: 'x.m4a', streams: [audio(0, 'spa')] }]), MediaProblem);
});
