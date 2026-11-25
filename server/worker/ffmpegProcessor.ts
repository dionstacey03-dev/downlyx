import { spawn, spawnSync } from 'child_process';
import fsPromises from 'fs/promises';
import {
  DEFAULT_TEMP_STORAGE_DIR,
  assertConfinedTempPath,
} from '../storage/tempStorage.ts';

export const DEFAULT_MAX_MEDIA_DURATION_SECONDS = 600; // 10 minutes max processing duration
const DEFAULT_FFMPEG_AS_LIMIT_BYTES = 512 * 1024 * 1024; // 512 MB virtual address space
const DEFAULT_FFMPEG_CPU_SECONDS = 60;

const HAS_PRLIMIT = (() => {
  try {
    const res = spawnSync('prlimit', ['--version'], {
      shell: false,
      stdio: 'ignore',
    });
    return res.status === 0;
  } catch {
    return false;
  }
})();

export interface FfprobeInspection {
  formatName: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  resolutionLabel?: string;
  videoCodec?: string;
  audioCodec?: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

function sanitizedSpawnEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
  };
}

function runBinary(params: {
  command: 'ffmpeg' | 'ffprobe';
  args: string[];
  timeoutMs: number;
  maxOutputFileBytes?: number;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new Error('Media processing cancelled.'));
      return;
    }

    const usePrlimit = HAS_PRLIMIT;
    const spawnCmd = usePrlimit ? 'prlimit' : params.command;
    const prlimitArgs = usePrlimit
      ? [
          `--as=${DEFAULT_FFMPEG_AS_LIMIT_BYTES}`,
          `--cpu=${DEFAULT_FFMPEG_CPU_SECONDS}`,
          ...(params.maxOutputFileBytes
            ? [`--fsize=${params.maxOutputFileBytes}`]
            : []),
          '--',
          params.command,
        ]
      : [];

    const child = spawn(spawnCmd, [...prlimitArgs, ...params.args], {
      shell: false,
      env: sanitizedSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    const maxLogBytes = 256 * 1024;
    let settled = false;

    const cleanupListeners = () => {
      params.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };

    const killChildGroup = () => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          setTimeout(() => {
            if (!child.killed && child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                try {
                  child.kill('SIGKILL');
                } catch {
                  // ignore
                }
              }
            }
          }, 400);
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      killChildGroup();
      reject(new Error('Media processing cancelled.'));
    };

    params.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      killChildGroup();
      reject(new Error(`${params.command} execution timed out.`));
    }, params.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (totalBytes + chunk.length <= maxLogBytes) {
        stdoutChunks.push(chunk);
        totalBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrChunks.reduce((a, b) => a + b.length, 0) < maxLogBytes) {
        stderrChunks.push(chunk);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? 1,
      });
    });
  });
}

export async function inspectMediaWithFfprobe(
  filePath: string,
  baseDir = DEFAULT_TEMP_STORAGE_DIR,
  signal?: AbortSignal
): Promise<FfprobeInspection> {
  const confined = assertConfinedTempPath(filePath, baseDir);
  const res = await runBinary({
    command: 'ffprobe',
    args: [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      confined,
    ],
    timeoutMs: 12_000,
    signal,
  });

  if (res.exitCode !== 0) {
    throw new Error(
      `Media container inspection failed: ${res.stderr.trim() || 'corrupt or unsupported media file.'}`
    );
  }

  let parsed: {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
  };

  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    throw new Error('ffprobe returned unreadable metadata.');
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const rawDur = parsed.format?.duration ? Number(parsed.format.duration) : NaN;
  const durationSeconds =
    Number.isFinite(rawDur) && rawDur > 0 ? Math.round(rawDur * 10) / 10 : undefined;

  const width =
    typeof videoStream?.width === 'number' && videoStream.width > 0
      ? videoStream.width
      : undefined;
  const height =
    typeof videoStream?.height === 'number' && videoStream.height > 0
      ? videoStream.height
      : undefined;

  return {
    formatName: parsed.format?.format_name || 'unknown',
    durationSeconds,
    width,
    height,
    resolutionLabel: width && height ? `${width}x${height}` : undefined,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
}

export async function verifyMediaIntegrity(params: {
  filePath: string;
  expectedCategory: 'Video' | 'Audio' | 'Image';
  baseDir?: string;
  maxDurationSeconds?: number;
  signal?: AbortSignal;
}): Promise<FfprobeInspection> {
  const baseDir = params.baseDir ?? DEFAULT_TEMP_STORAGE_DIR;
  const maxDuration =
    params.maxDurationSeconds ?? DEFAULT_MAX_MEDIA_DURATION_SECONDS;
  const confined = assertConfinedTempPath(params.filePath, baseDir);
  const info = await inspectMediaWithFfprobe(confined, baseDir, params.signal);

  if (
    info.durationSeconds !== undefined &&
    info.durationSeconds > maxDuration
  ) {
    throw new Error(
      `Media duration (${info.durationSeconds}s) exceeds maximum allowed limit (${maxDuration}s).`
    );
  }

  if (params.expectedCategory === 'Audio' && !info.hasAudio) {
    throw new Error('File integrity check failed: no valid audio stream found.');
  }
  if (params.expectedCategory === 'Video' && !info.hasVideo && !info.hasAudio) {
    throw new Error('File integrity check failed: no valid media streams found.');
  }
  if (params.expectedCategory === 'Image' && !info.hasVideo) {
    throw new Error('File integrity check failed: invalid image stream.');
  }

  // Lightweight decode integrity verification for audio/video containers (local file protocol only)
  if (params.expectedCategory === 'Video' || params.expectedCategory === 'Audio') {
    const decodeRes = await runBinary({
      command: 'ffmpeg',
      args: [
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-threads',
        '1',
        '-i',
        confined,
        '-t',
        '2',
        '-f',
        'null',
        '-',
      ],
      timeoutMs: 15_000,
      signal: params.signal,
    });
    if (decodeRes.exitCode !== 0) {
      throw new Error(
        `Container integrity check failed: ${decodeRes.stderr.trim() || 'stream decode error.'}`
      );
    }
  }

  return info;
}

export async function transformMediaWithFfmpeg(params: {
  inputPath: string;
  outputPath: string;
  targetFormat: string;
  sourceContainer: string;
  hasAudio: boolean;
  hasVideo: boolean;
  baseDir?: string;
  maxDurationSeconds?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const baseDir = params.baseDir ?? DEFAULT_TEMP_STORAGE_DIR;
  const maxDuration =
    params.maxDurationSeconds ?? DEFAULT_MAX_MEDIA_DURATION_SECONDS;
  const maxOutputBytes = params.maxOutputBytes ?? 50 * 1024 * 1024;
  const confinedIn = assertConfinedTempPath(params.inputPath, baseDir);
  const confinedOut = assertConfinedTempPath(params.outputPath, baseDir);
  const target = params.targetFormat.toUpperCase();

  let codecArgs: string[];

  if (target === 'MP3') {
    if (!params.hasAudio) {
      throw new Error('Cannot extract MP3 audio: source file contains no audio stream.');
    }
    codecArgs = ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'];
  } else if (target === 'M4A') {
    if (!params.hasAudio) {
      throw new Error('Cannot extract M4A audio: source file contains no audio stream.');
    }
    codecArgs = ['-vn', '-c:a', 'aac', '-b:a', '192k'];
  } else if (target === 'WAV') {
    if (!params.hasAudio) {
      throw new Error('Cannot extract WAV audio: source file contains no audio stream.');
    }
    codecArgs = ['-vn', '-c:a', 'pcm_s16le'];
  } else if (target === 'OGG') {
    if (!params.hasAudio) {
      throw new Error('Cannot extract OGG audio: source file contains no audio stream.');
    }
    codecArgs = ['-vn', '-c:a', 'libvorbis', '-q:a', '4'];
  } else if (target === 'MP4') {
    if (params.sourceContainer === 'MP4') {
      codecArgs = ['-c', 'copy', '-movflags', '+faststart'];
    } else {
      codecArgs = ['-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-movflags', '+faststart'];
    }
  } else if (target === 'MOV') {
    codecArgs = ['-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac'];
  } else if (target === 'WEBM') {
    if (params.sourceContainer === 'WEBM') {
      codecArgs = ['-c', 'copy'];
    } else {
      codecArgs = ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus'];
    }
  } else if (target === 'PNG' || target === 'JPEG' || target === 'WEBP') {
    codecArgs = [];
  } else {
    throw new Error(`Unsupported FFmpeg target format "${target}".`);
  }

  const args = [
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
    '-threads',
    '1',
    '-i',
    confinedIn,
    '-t',
    String(maxDuration),
    '-max_muxing_queue_size',
    '1024',
    ...codecArgs,
    confinedOut,
  ];

  const res = await runBinary({
    command: 'ffmpeg',
    args,
    timeoutMs: 60_000,
    maxOutputFileBytes: maxOutputBytes,
    signal: params.signal,
  });

  if (res.exitCode !== 0) {
    throw new Error(
      `FFmpeg transformation to ${target} failed: ${res.stderr.trim() || 'encoding error.'}`
    );
  }

  const stat = await fsPromises.stat(confinedOut);
  if (stat.size > maxOutputBytes) {
    throw new Error(
      `Processed output file (${stat.size} bytes) exceeded maximum size limit (${maxOutputBytes} bytes).`
    );
  }
}
