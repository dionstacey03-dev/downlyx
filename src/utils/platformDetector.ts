import type {
  MediaTypeLabel,
  PlatformId,
  PlatformSpec,
  QualityPreference,
  UserPreferences,
  ValidationStatus,
} from '../types/media.ts';

export const STORAGE_KEYS = {
  theme: 'downlyx_theme',
  history: 'downlyx_history',
  preferences: 'downlyx_preferences',
  downloadsSearch: 'downlyx_downloads_search',
} as const;

export const DEFAULT_PREFERENCES: UserPreferences = {
  defaultQuality: 'best',
  defaultFormat: 'mp4',
  autoDetectClipboard: false,
  saveHistoryLocally: true,
  autoRetry: false,
  workspaceName: 'Personal Workspace',
};

export const QUALITY_PREFERENCE_LABELS: Record<QualityPreference, string> = {
  best: 'Best Available',
  standard: 'Standard',
  audio: 'Audio',
};

export function normalizeQualityPreference(value: unknown): QualityPreference {
  if (value === 'best' || value === 'standard' || value === 'audio') {
    return value;
  }
  if (value === '720p') return 'standard';
  return 'best';
}

export const PLATFORM_HOST_ALLOWLISTS = {
  youtube: new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
  ]),
  instagram: new Set(['instagram.com', 'www.instagram.com', 'instagr.am']),
  tiktok: new Set([
    'tiktok.com',
    'www.tiktok.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'm.tiktok.com',
  ]),
  facebook: new Set([
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
    'web.facebook.com',
    'fb.watch',
  ]),
  x: new Set([
    'x.com',
    'www.x.com',
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com',
  ]),
} as const;

export const DIRECT_VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v']);
export const DIRECT_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
export const DIRECT_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

export const SUPPORTED_PLATFORMS: PlatformSpec[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    shortLabel: 'YouTube',
    tagline: 'Public watch links, Shorts, live archives, and youtu.be share URLs.',
    domains: ['youtube.com', 'youtu.be', 'music.youtube.com'],
    supportedTypes: ['Video', 'Short Video', 'Audio Stream'],
    formatOptions: ['Verified via provider only'],
    qualityTiers: ['Best Available (Disabled pending YouTube approval)'],
    exampleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    patternSummary: 'youtube.com/watch?v=... · youtu.be/... · youtube.com/shorts/...',
    phaseNote:
      'URL detection and authorized oEmbed metadata lookup are active. YouTube downloads remain disabled unless expressly approved by YouTube.',
    capabilities: {
      urlDetection: {
        label: 'URL Detection',
        state: 'Supported (Watch, Shorts, Embed, Live, youtu.be)',
        status: 'supported',
      },
      metadataAvailability: {
        label: 'Metadata Availability',
        state: 'Supported via official YouTube oEmbed lookup',
        status: 'supported',
      },
      authorizedRetrieval: {
        label: 'Authorized Media Retrieval',
        state: 'Restricted — requires express YouTube approval',
        status: 'restricted',
      },
      downloadAvailability: {
        label: 'Actual Download Availability',
        state: 'Not available — downloads disabled without approval',
        status: 'not_available',
      },
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    shortLabel: 'Instagram',
    tagline: 'Public Reels, feed posts, and Story URL pattern recognition.',
    domains: ['instagram.com', 'instagr.am'],
    supportedTypes: ['Reel', 'Post Media', 'Story'],
    formatOptions: ['Requires authorization'],
    qualityTiers: ['Unavailable without authorized metadata'],
    exampleUrl: 'https://www.instagram.com/reel/C8xYz9AbCdE/',
    patternSummary:
      'instagram.com/reel/... · instagram.com/p/... · instagram.com/stories/<user>/<id>',
    phaseNote:
      'URL structure detection is active. Metadata and retrieval require authorized API credentials; private content is never accessed.',
    storyNote:
      'Instagram Stories: URL detection recognizes /stories/<username>/<id>, but private accounts, Close Friends, expired stories, and login-gated Stories are strictly restricted and never accessed or bypassed.',
    capabilities: {
      urlDetection: {
        label: 'URL Detection',
        state: 'Supported (Reels, Posts, IGTV, Stories URL format)',
        status: 'supported',
      },
      metadataAvailability: {
        label: 'Metadata Availability',
        state: 'Requires authorization (Restricted for Stories)',
        status: 'requires_authorization',
      },
      authorizedRetrieval: {
        label: 'Authorized Media Retrieval',
        state: 'Requires authorization · Private Stories strictly restricted',
        status: 'requires_authorization',
      },
      downloadAvailability: {
        label: 'Actual Download Availability',
        state: 'Not available in Phase 2',
        status: 'not_available',
      },
    },
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    shortLabel: 'TikTok',
    tagline: 'Public creator video links, photo posts, and vm.tiktok.com share links.',
    domains: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    supportedTypes: ['Short Video', 'Post Media'],
    formatOptions: ['Verified via provider only'],
    qualityTiers: ['Best Available (Pending authorized retrieval)'],
    exampleUrl: 'https://www.tiktok.com/@creator/video/7349182736451234567',
    patternSummary: 'tiktok.com/@user/video/... · vm.tiktok.com/...',
    phaseNote:
      'URL structure validation and official TikTok oEmbed lookup (for canonical URLs) are active. Short links are not blindly followed to prevent redirect risks.',
    capabilities: {
      urlDetection: {
        label: 'URL Detection',
        state: 'Supported (Full video, photo, and vm/vt short links)',
        status: 'supported',
      },
      metadataAvailability: {
        label: 'Metadata Availability',
        state: 'Supported via official TikTok oEmbed for canonical URLs',
        status: 'supported',
      },
      authorizedRetrieval: {
        label: 'Authorized Media Retrieval',
        state: 'Requires authorization',
        status: 'requires_authorization',
      },
      downloadAvailability: {
        label: 'Actual Download Availability',
        state: 'Not available in Phase 2',
        status: 'not_available',
      },
    },
  },
  {
    id: 'facebook',
    name: 'Facebook',
    shortLabel: 'Facebook',
    tagline: 'Public Watch videos, Reels, and fb.watch share links.',
    domains: ['facebook.com', 'fb.watch'],
    supportedTypes: ['Video', 'Reel'],
    formatOptions: ['Requires authorization'],
    qualityTiers: ['Unavailable without authorized metadata'],
    exampleUrl: 'https://www.facebook.com/watch/?v=10153231379946729',
    patternSummary: 'facebook.com/watch/?v=... · facebook.com/reel/... · fb.watch/...',
    phaseNote:
      'URL structure validation is active. Metadata and retrieval require authorized Meta Graph access; private posts are excluded.',
    capabilities: {
      urlDetection: {
        label: 'URL Detection',
        state: 'Supported (Watch, Reel, Videos, fb.watch)',
        status: 'supported',
      },
      metadataAvailability: {
        label: 'Metadata Availability',
        state: 'Requires authorization',
        status: 'requires_authorization',
      },
      authorizedRetrieval: {
        label: 'Authorized Media Retrieval',
        state: 'Requires authorization · Private/friends-only posts excluded',
        status: 'requires_authorization',
      },
      downloadAvailability: {
        label: 'Actual Download Availability',
        state: 'Not available in Phase 2',
        status: 'not_available',
      },
    },
  },
  {
    id: 'x',
    name: 'X / Twitter',
    shortLabel: 'X / Twitter',
    tagline: 'Public post status links containing embedded video or image media.',
    domains: ['x.com', 'twitter.com'],
    supportedTypes: ['Post Media'],
    formatOptions: ['Requires authorization'],
    qualityTiers: ['Unavailable without authorized metadata'],
    exampleUrl: 'https://x.com/nasa/status/1841234567890123456',
    patternSummary: 'x.com/<user>/status/<id> · twitter.com/<user>/status/<id>',
    phaseNote:
      'Status ID extraction is active. Post metadata and media variants require authorized X API credentials.',
    capabilities: {
      urlDetection: {
        label: 'URL Detection',
        state: 'Supported (x.com & twitter.com status URLs)',
        status: 'supported',
      },
      metadataAvailability: {
        label: 'Metadata Availability',
        state: 'Requires authorization',
        status: 'requires_authorization',
      },
      authorizedRetrieval: {
        label: 'Authorized Media Retrieval',
        state: 'Requires authorization · Protected accounts excluded',
        status: 'requires_authorization',
      },
      downloadAvailability: {
        label: 'Actual Download Availability',
        state: 'Not available in Phase 2',
        status: 'not_available',
      },
    },
  },
  {
    id: 'direct',
    name: 'Direct Media URLs',
    shortLabel: 'Direct URLs',
    tagline: 'Direct HTTPS links ending in MP4, WebM, MOV, MP3, WAV, M4A, OGG, PNG, JPEG, or WebP.',
    domains: ['Any verified public HTTPS domain'],
    supportedTypes: ['Probable Video', 'Probable Audio', 'Probable Image'],
    formatOptions: ['MP4', 'WebM', 'MOV', 'MP3', 'WAV', 'M4A', 'OGG', 'PNG', 'JPEG', 'WebP'],
    qualityTiers: ['Original Verified Asset / Audio Extraction'],
    exampleUrl: 'https://cdn.example.com/assets/sample-reel-1080p.mp4',
    patternSummary: 'https://host/path/file.mp4 (.webm, .mov, .mp3, .wav, .m4a, .ogg, .png, .jpg, .webp)',
    phaseNote:
      'Path extensions indicate only a probable media URL. Actual MIME type, binary file signature, and FFprobe integrity are verified in the isolated download worker when you confirm permission.',
    capabilities: {
      urlDetection: {
        label: 'URL Detection',
        state: 'Supported (HTTPS domain & probable media path)',
        status: 'supported',
      },
      metadataAvailability: {
        label: 'Metadata Availability',
        state: 'Verified via FFprobe inside isolated worker during download',
        status: 'supported',
      },
      authorizedRetrieval: {
        label: 'Authorized Media Retrieval',
        state: 'Supported (Requires user ownership / permission confirmation)',
        status: 'supported',
      },
      downloadAvailability: {
        label: 'Actual Download Availability',
        state: 'Supported via isolated streaming & FFmpeg worker',
        status: 'supported',
      },
    },
  },
];

export interface UrlSecurityValidation {
  valid: boolean;
  validationStatus: ValidationStatus;
  normalizedUrl: string;
  hostname: string;
  parsed?: URL;
  error?: string;
  warnings: string[];
  missingProtocolHint: boolean;
}

const REDIRECT_PARAM_NAMES = new Set([
  'url',
  'u',
  'q',
  'redirect',
  'redirect_url',
  'redirect_uri',
  'next',
  'target',
  'dest',
  'destination',
  'continue',
  'return',
  'return_to',
  'to',
  'link',
]);

const REDIRECT_PATH_SEGMENTS = ['/redirect', '/l.php', '/out/', '/away/', '/go/'];

export function isIpLiteralOrObfuscatedHost(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return true;

  // Standard IPv4 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean)) return true;

  // IPv6 literal (contains colon)
  if (clean.includes(':')) return true;

  // Decimal integer IP bypass (e.g. 2130706433) or hex IP (0x7f000001)
  if (/^\d+$/.test(clean) || /^0x[0-9a-f]+$/i.test(clean)) return true;

  // Shorthand, octal, or hex dotted IPv4 bypasses (e.g. 127.1, 0177.0.0.1, 0x7f.0.0.1)
  const parts = clean.split('.');
  if (
    parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))
  ) {
    return true;
  }

  return false;
}

export function isRestrictedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!lower || !lower.includes('.')) return true;

  if (
    lower === 'localhost' ||
    lower === 'localhost.localdomain' ||
    lower === 'metadata' ||
    lower === 'metadata.google.internal' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.lan') ||
    lower.endsWith('.home') ||
    lower.endsWith('.arpa')
  ) {
    return true;
  }

  return isIpLiteralOrObfuscatedHost(lower);
}

function isDangerousRedirectTarget(rawTarget: string): boolean {
  let decoded = rawTarget.trim();
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }

  const lower = decoded.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vbscript:')
  ) {
    return true;
  }

  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')) {
    try {
      const candidate = new URL(lower.startsWith('//') ? `https:${decoded}` : decoded);
      if (isRestrictedHostname(candidate.hostname)) {
        return true;
      }
      if (candidate.hostname.toLowerCase() === 'localhost') {
        return true;
      }
    } catch {
      return true;
    }
  }

  if (
    /(?:^|\/|@)(?:localhost|127\.0\.0\.1|169\.254\.169\.254|0\.0\.0\.0|\[::1\])/i.test(
      decoded
    )
  ) {
    return true;
  }

  return false;
}

export function validateExternalHttpsUrl(rawInput: string): UrlSecurityValidation {
  if (typeof rawInput !== 'string') {
    return {
      valid: false,
      validationStatus: 'invalid',
      normalizedUrl: '',
      hostname: '',
      error: 'URL must be a text string.',
      warnings: [],
      missingProtocolHint: false,
    };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      valid: false,
      validationStatus: 'invalid',
      normalizedUrl: '',
      hostname: '',
      error: 'Please enter or paste an HTTPS media URL before analyzing.',
      warnings: [],
      missingProtocolHint: false,
    };
  }

  if (trimmed.length > 2048) {
    return {
      valid: false,
      validationStatus: 'invalid',
      normalizedUrl: trimmed.slice(0, 128),
      hostname: '',
      error: 'URL exceeds the maximum allowed length of 2048 characters.',
      warnings: [],
      missingProtocolHint: false,
    };
  }

  // Reject embedded control chars, whitespace, or backslash normalization tricks
  if (/[\x00-\x1f\x7f\s\\]/.test(trimmed)) {
    return {
      valid: false,
      validationStatus: 'blocked',
      normalizedUrl: trimmed,
      hostname: '',
      error: 'Malformed URL: whitespace, control characters, or backslashes are not permitted.',
      warnings: ['Deceptive or malformed URL characters blocked.'],
      missingProtocolHint: false,
    };
  }

  const missingProtocolHint =
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) &&
    /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/|$)/.test(trimmed);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      validationStatus: 'invalid',
      normalizedUrl: trimmed,
      hostname: '',
      error: missingProtocolHint
        ? `Missing protocol. Add "https://" at the beginning (e.g. https://${trimmed}).`
        : 'Malformed URL. Enter a complete URL starting with https://.',
      warnings: [],
      missingProtocolHint,
    };
  }

  // Enforce HTTPS-only
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      validationStatus: 'blocked',
      normalizedUrl: parsed.toString(),
      hostname: parsed.hostname,
      error: `Only HTTPS URLs are permitted. Protocol "${parsed.protocol}" is blocked.`,
      warnings: ['Insecure or unsupported URL protocol rejected.'],
      missingProtocolHint: false,
    };
  }

  // Reject deceptive userinfo (@) authority bypasses
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      valid: false,
      validationStatus: 'blocked',
      normalizedUrl: parsed.toString(),
      hostname: parsed.hostname,
      error: 'URLs containing embedded username or password credentials are blocked.',
      warnings: ['Deceptive credential authority syntax rejected.'],
      missingProtocolHint: false,
    };
  }

  // Reject restricted hosts, localhost, private IPs, and IP literal bypasses
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || isRestrictedHostname(host)) {
    return {
      valid: false,
      validationStatus: 'blocked',
      normalizedUrl: parsed.toString(),
      hostname: host,
      error:
        'Localhost, IP literals, private network ranges, and internal metadata hosts are blocked.',
      warnings: ['SSRF protection blocked private or IP-literal destination.'],
      missingProtocolHint: false,
    };
  }

  // Reject non-standard ports on external media links if deceptive, or allow default/443 only
  if (parsed.port && parsed.port !== '443') {
    return {
      valid: false,
      validationStatus: 'blocked',
      normalizedUrl: parsed.toString(),
      hostname: host,
      error: `Custom port ":${parsed.port}" is blocked. Only standard HTTPS (443) URLs are accepted.`,
      warnings: ['Non-standard port blocked by URL security policy.'],
      missingProtocolHint: false,
    };
  }

  // Detect open-redirect or redirect-attack payloads pointing to internal/private targets
  const pathLower = parsed.pathname.toLowerCase();
  const isKnownRedirectPath = REDIRECT_PATH_SEGMENTS.some((seg) =>
    pathLower.startsWith(seg)
  );
  for (const [paramKey, paramVal] of parsed.searchParams.entries()) {
    const keyLower = paramKey.toLowerCase();
    if (
      (REDIRECT_PARAM_NAMES.has(keyLower) || isKnownRedirectPath) &&
      isDangerousRedirectTarget(paramVal)
    ) {
      return {
        valid: false,
        validationStatus: 'blocked',
        normalizedUrl: parsed.toString(),
        hostname: host,
        error:
          'Redirect attack detected: query parameter targets a restricted, private, or unsafe destination.',
        warnings: ['Blocked suspicious redirect target in query parameters.'],
        missingProtocolHint: false,
      };
    }
  }

  return {
    valid: true,
    validationStatus: 'valid',
    normalizedUrl: parsed.toString(),
    hostname: host,
    parsed,
    warnings: [],
    missingProtocolHint: false,
  };
}

export function getDirectMediaExtension(pathname: string): string | null {
  const cleanPath = pathname.split('?')[0].split('#')[0];
  const lastSegment = cleanPath.split('/').pop() ?? '';
  const dotIdx = lastSegment.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === lastSegment.length - 1) return null;
  return lastSegment.slice(dotIdx + 1).toLowerCase();
}

export interface PlatformPatternMatch {
  platform: PlatformId;
  platformName: string;
  mediaType: MediaTypeLabel;
  resourceId: string | null;
  isSupportedPattern: boolean;
  isStory?: boolean;
  directExtension?: string;
  patternError?: string;
}

export function detectPlatformPattern(parsed: URL): PlatformPatternMatch {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // 1. YouTube
  if (PLATFORM_HOST_ALLOWLISTS.youtube.has(host)) {
    let videoId: string | null = null;
    let mediaType: MediaTypeLabel = 'Video';

    if (host === 'youtu.be') {
      videoId = path.replace(/^\/+/, '').split('/')[0] || null;
    } else if (path.startsWith('/shorts/')) {
      mediaType = 'Short Video';
      videoId = path.split('/')[2] || null;
    } else if (path.startsWith('/embed/') || path.startsWith('/live/')) {
      videoId = path.split('/')[2] || null;
    } else if (path === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else if (host === 'music.youtube.com') {
      mediaType = 'Audio';
      videoId = parsed.searchParams.get('v');
    }

    if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
      return {
        platform: 'youtube',
        platformName: 'YouTube',
        mediaType: 'Unknown',
        resourceId: null,
        isSupportedPattern: false,
        patternError:
          'YouTube domain recognized, but no valid video or Shorts ID was found (e.g. https://www.youtube.com/watch?v=...).',
      };
    }

    return {
      platform: 'youtube',
      platformName: 'YouTube',
      mediaType,
      resourceId: videoId,
      isSupportedPattern: true,
    };
  }

  // 2. Instagram
  if (PLATFORM_HOST_ALLOWLISTS.instagram.has(host)) {
    const storyMatch = path.match(/^\/stories\/([A-Za-z0-9._]+)(?:\/(\d+))?/);
    if (storyMatch) {
      return {
        platform: 'instagram',
        platformName: 'Instagram',
        mediaType: 'Story',
        resourceId: storyMatch[2] || storyMatch[1],
        isSupportedPattern: true,
        isStory: true,
      };
    }

    const igMatch = path.match(/^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    if (!igMatch) {
      return {
        platform: 'instagram',
        platformName: 'Instagram',
        mediaType: 'Unknown',
        resourceId: null,
        isSupportedPattern: false,
        patternError:
          'Instagram domain recognized, but URL does not point to a /reel/, /p/, or /stories/ resource.',
      };
    }

    const mediaType: MediaTypeLabel = igMatch[1].startsWith('reel')
      ? 'Reel'
      : 'Post Media';

    return {
      platform: 'instagram',
      platformName: 'Instagram',
      mediaType,
      resourceId: igMatch[2],
      isSupportedPattern: true,
      isStory: false,
    };
  }

  // 3. TikTok
  if (PLATFORM_HOST_ALLOWLISTS.tiktok.has(host)) {
    const fullMatch = path.match(/^\/@([A-Za-z0-9._-]+)\/(video|photo)\/(\d+)/);
    const shortMatch =
      (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') &&
      path.replace(/^\/+/, '').split('/')[0];

    if (!fullMatch && !shortMatch) {
      return {
        platform: 'tiktok',
        platformName: 'TikTok',
        mediaType: 'Unknown',
        resourceId: null,
        isSupportedPattern: false,
        patternError:
          'TikTok domain recognized, but no video ID or short share code was found.',
      };
    }

    const mediaType: MediaTypeLabel =
      fullMatch && fullMatch[2] === 'photo' ? 'Post Media' : 'Short Video';
    const resourceId = fullMatch ? fullMatch[3] : (shortMatch as string);

    return {
      platform: 'tiktok',
      platformName: 'TikTok',
      mediaType,
      resourceId,
      isSupportedPattern: true,
    };
  }

  // 4. Facebook
  if (PLATFORM_HOST_ALLOWLISTS.facebook.has(host)) {
    let resourceId: string | null = null;
    let mediaType: MediaTypeLabel = 'Video';

    if (host === 'fb.watch') {
      resourceId = path.replace(/^\/+/, '').split('/')[0] || null;
    } else if (path.startsWith('/reel/')) {
      mediaType = 'Reel';
      resourceId = path.split('/')[2] || null;
    } else if (path.startsWith('/watch')) {
      resourceId = parsed.searchParams.get('v');
    } else {
      const vidMatch = path.match(/\/videos\/(\d+)/);
      if (vidMatch) resourceId = vidMatch[1];
    }

    if (!resourceId) {
      return {
        platform: 'facebook',
        platformName: 'Facebook',
        mediaType: 'Unknown',
        resourceId: null,
        isSupportedPattern: false,
        patternError:
          'Facebook domain recognized, but no Watch video ID, Reel ID, or fb.watch code was found.',
      };
    }

    return {
      platform: 'facebook',
      platformName: 'Facebook',
      mediaType,
      resourceId,
      isSupportedPattern: true,
    };
  }

  // 5. X / Twitter
  if (PLATFORM_HOST_ALLOWLISTS.x.has(host)) {
    const statusMatch = path.match(/^\/[A-Za-z0-9_]+\/status\/(\d+)/);
    if (!statusMatch) {
      return {
        platform: 'x',
        platformName: 'X / Twitter',
        mediaType: 'Unknown',
        resourceId: null,
        isSupportedPattern: false,
        patternError:
          'X / Twitter domain recognized, but URL does not reference a specific /<user>/status/<id> post.',
      };
    }

    return {
      platform: 'x',
      platformName: 'X / Twitter',
      mediaType: 'Post Media',
      resourceId: statusMatch[1],
      isSupportedPattern: true,
    };
  }

  // 6. Direct Media URLs
  const ext = getDirectMediaExtension(path);
  if (ext) {
    if (DIRECT_VIDEO_EXTS.has(ext)) {
      return {
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Video',
        resourceId: path.split('/').pop() || null,
        isSupportedPattern: true,
        directExtension: ext.toUpperCase(),
      };
    }
    if (DIRECT_AUDIO_EXTS.has(ext)) {
      return {
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Audio',
        resourceId: path.split('/').pop() || null,
        isSupportedPattern: true,
        directExtension: ext.toUpperCase(),
      };
    }
    if (DIRECT_IMAGE_EXTS.has(ext)) {
      return {
        platform: 'direct',
        platformName: 'Direct Media URL',
        mediaType: 'Image',
        resourceId: path.split('/').pop() || null,
        isSupportedPattern: true,
        directExtension: ext.toUpperCase(),
      };
    }
  }

  return {
    platform: 'unsupported',
    platformName: 'Unsupported Domain',
    mediaType: 'Unknown',
    resourceId: null,
    isSupportedPattern: false,
    patternError: `Unsupported domain "${host}". Only YouTube, Instagram, TikTok, Facebook, X / Twitter, and Direct Media URLs are supported.`,
  };
}

export function detectPlatformQuick(rawInput: string): {
  platform: PlatformId;
  platformName: string;
  mediaType: MediaTypeLabel;
  isValidUrl: boolean;
  isSupported: boolean;
  isBlocked: boolean;
  missingProtocolHint: boolean;
  message?: string;
} {
  const security = validateExternalHttpsUrl(rawInput);
  if (!security.valid || !security.parsed) {
    return {
      platform: 'unsupported',
      platformName: 'Invalid',
      mediaType: 'Unknown',
      isValidUrl: false,
      isSupported: false,
      isBlocked: security.validationStatus === 'blocked',
      missingProtocolHint: security.missingProtocolHint,
      message: security.error,
    };
  }

  const pattern = detectPlatformPattern(security.parsed);
  return {
    platform: pattern.platform,
    platformName: pattern.platformName,
    mediaType: pattern.mediaType,
    isValidUrl: true,
    isSupported: pattern.isSupportedPattern && !pattern.isStory,
    isBlocked: false,
    missingProtocolHint: false,
    message: pattern.patternError,
  };
}
