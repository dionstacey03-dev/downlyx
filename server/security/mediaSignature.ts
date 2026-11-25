export interface MediaSignatureResult {
  verified: boolean;
  mimeType: string | null;
  detectedContainer: string | null;
  reason: string;
}

const ALLOWED_MEDIA_MIME_PREFIXES = ['video/', 'audio/', 'image/'];
const BLOCKED_MEDIA_MIMES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'text/javascript',
  'application/x-sh',
  'application/x-executable',
]);

function matchesBytes(buf: Uint8Array, offset: number, sig: number[]): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function matchesAscii(buf: Uint8Array, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function detectFileSignature(buf: Uint8Array): {
  container: string;
  compatibleMimes: string[];
} | null {
  if (buf.length < 4) return null;

  // ISO BMFF (MP4 / M4A / MOV): ....ftyp
  if (buf.length >= 12 && matchesAscii(buf, 4, 'ftyp')) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (brand === 'qt  ') {
      return { container: 'MOV', compatibleMimes: ['video/quicktime'] };
    }
    if (brand === 'M4A ' || brand === 'M4B ') {
      return {
        container: 'M4A',
        compatibleMimes: ['audio/mp4', 'audio/x-m4a', 'video/mp4'],
      };
    }
    return { container: 'MP4', compatibleMimes: ['video/mp4', 'audio/mp4'] };
  }

  // EBML (WebM / Matroska)
  if (matchesBytes(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return {
      container: 'WEBM',
      compatibleMimes: ['video/webm', 'audio/webm', 'video/x-matroska'],
    };
  }

  // PNG
  if (
    matchesBytes(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return { container: 'PNG', compatibleMimes: ['image/png'] };
  }

  // JPEG
  if (matchesBytes(buf, 0, [0xff, 0xd8, 0xff])) {
    return { container: 'JPG', compatibleMimes: ['image/jpeg'] };
  }

  // GIF
  if (matchesAscii(buf, 0, 'GIF87a') || matchesAscii(buf, 0, 'GIF89a')) {
    return { container: 'GIF', compatibleMimes: ['image/gif'] };
  }

  // RIFF (WAV or WebP)
  if (buf.length >= 12 && matchesAscii(buf, 0, 'RIFF')) {
    if (matchesAscii(buf, 8, 'WAVE')) {
      return {
        container: 'WAV',
        compatibleMimes: ['audio/wav', 'audio/x-wav', 'audio/wave'],
      };
    }
    if (matchesAscii(buf, 8, 'WEBP')) {
      return { container: 'WEBP', compatibleMimes: ['image/webp'] };
    }
  }

  // MP3 (ID3 tag or MPEG frame sync)
  if (
    matchesAscii(buf, 0, 'ID3') ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) {
    return { container: 'MP3', compatibleMimes: ['audio/mpeg', 'audio/mp3'] };
  }

  // OGG
  if (matchesAscii(buf, 0, 'OggS')) {
    return {
      container: 'OGG',
      compatibleMimes: ['audio/ogg', 'video/ogg', 'application/ogg'],
    };
  }

  // FLAC
  if (matchesAscii(buf, 0, 'fLaC')) {
    return { container: 'FLAC', compatibleMimes: ['audio/flac', 'audio/x-flac'] };
  }

  return null;
}

export function verifyMediaMimeAndSignature(
  contentTypeHeader: string | null | undefined,
  headerBytes: Uint8Array
): MediaSignatureResult {
  const mime = (contentTypeHeader ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!mime) {
    return {
      verified: false,
      mimeType: null,
      detectedContainer: null,
      reason: 'Missing Content-Type header.',
    };
  }

  if (BLOCKED_MEDIA_MIMES.has(mime)) {
    return {
      verified: false,
      mimeType: mime,
      detectedContainer: null,
      reason: `Blocked unsafe or non-media MIME type "${mime}".`,
    };
  }

  const hasAllowedPrefix = ALLOWED_MEDIA_MIME_PREFIXES.some((prefix) =>
    mime.startsWith(prefix)
  );
  if (!hasAllowedPrefix) {
    return {
      verified: false,
      mimeType: mime,
      detectedContainer: null,
      reason: `Unexpected MIME type "${mime}"; expected video/*, audio/*, or image/*.`,
    };
  }

  const signature = detectFileSignature(headerBytes);
  if (!signature) {
    return {
      verified: false,
      mimeType: mime,
      detectedContainer: null,
      reason: 'Binary file signature did not match any supported media container.',
    };
  }

  if (!signature.compatibleMimes.includes(mime)) {
    return {
      verified: false,
      mimeType: mime,
      detectedContainer: signature.container,
      reason: `MIME type "${mime}" does not match binary ${signature.container} signature.`,
    };
  }

  return {
    verified: true,
    mimeType: mime,
    detectedContainer: signature.container,
    reason: `Verified ${signature.container} file signature and ${mime} MIME type.`,
  };
}
