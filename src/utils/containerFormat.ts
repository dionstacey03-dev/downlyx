import type {
  AnalyzeResponse,
  ContainerCategory,
  FormatPreference,
  FormatVariantOption,
} from '../types/media.ts';
import { getDirectMediaExtension } from './platformDetector.ts';

interface ContainerDescriptor {
  label: string;
  category: ContainerCategory;
  mimeHint: string;
}

export const CONTAINER_CATALOG: Record<string, ContainerDescriptor> = {
  MP4: {
    label: 'MP4 Video (H.264 / AAC)',
    category: 'video',
    mimeHint: 'video/mp4',
  },
  WEBM: {
    label: 'WebM Video (VP9 / Opus)',
    category: 'video',
    mimeHint: 'video/webm',
  },
  MOV: {
    label: 'QuickTime MOV',
    category: 'video',
    mimeHint: 'video/quicktime',
  },
  MKV: {
    label: 'Matroska MKV',
    category: 'video',
    mimeHint: 'video/x-matroska',
  },
  MP3: {
    label: 'MP3 Audio',
    category: 'audio',
    mimeHint: 'audio/mpeg',
  },
  M4A: {
    label: 'M4A Audio (AAC)',
    category: 'audio',
    mimeHint: 'audio/mp4',
  },
  WAV: {
    label: 'WAV Lossless Audio',
    category: 'audio',
    mimeHint: 'audio/wav',
  },
  OGG: {
    label: 'OGG Vorbis Audio',
    category: 'audio',
    mimeHint: 'audio/ogg',
  },
  AAC: {
    label: 'AAC Audio',
    category: 'audio',
    mimeHint: 'audio/aac',
  },
  FLAC: {
    label: 'FLAC Lossless Audio',
    category: 'audio',
    mimeHint: 'audio/flac',
  },
  PNG: {
    label: 'PNG Image',
    category: 'image',
    mimeHint: 'image/png',
  },
  JPEG: {
    label: 'JPEG Image',
    category: 'image',
    mimeHint: 'image/jpeg',
  },
  WEBP: {
    label: 'WebP Image',
    category: 'image',
    mimeHint: 'image/webp',
  },
  GIF: {
    label: 'GIF Image',
    category: 'image',
    mimeHint: 'image/gif',
  },
};

const ALIAS_TO_CONTAINER: Record<string, string> = {
  JPG: 'JPEG',
  JPE: 'JPEG',
  M4V: 'MP4',
  QT: 'MOV',
  OGV: 'OGG',
  OGA: 'OGG',
  OPUS: 'OGG',
  MPEG: 'MP3',
  MPGA: 'MP3',
  WAVE: 'WAV',
  'VIDEO/MP4': 'MP4',
  'VIDEO/X-M4V': 'MP4',
  'VIDEO/WEBM': 'WEBM',
  'VIDEO/QUICKTIME': 'MOV',
  'VIDEO/X-MATROSKA': 'MKV',
  'AUDIO/MPEG': 'MP3',
  'AUDIO/MP3': 'MP3',
  'AUDIO/MP4': 'M4A',
  'AUDIO/X-M4A': 'M4A',
  'AUDIO/WAV': 'WAV',
  'AUDIO/X-WAV': 'WAV',
  'AUDIO/WAVE': 'WAV',
  'AUDIO/OGG': 'OGG',
  'APPLICATION/OGG': 'OGG',
  'AUDIO/AAC': 'AAC',
  'AUDIO/FLAC': 'FLAC',
  'IMAGE/PNG': 'PNG',
  'IMAGE/JPEG': 'JPEG',
  'IMAGE/JPG': 'JPEG',
  'IMAGE/WEBP': 'WEBP',
  'IMAGE/GIF': 'GIF',
};

const QUERY_CONTAINER_KEYS = [
  'format',
  'ext',
  'container',
  'mime',
  'type',
  'response-content-type',
];

export function normalizeContainerFormat(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .split(';')[0]
    .trim()
    .replace(/^\.+/, '')
    .toUpperCase();
  if (!cleaned) return null;
  const mapped = ALIAS_TO_CONTAINER[cleaned] ?? cleaned;
  return CONTAINER_CATALOG[mapped] ? mapped : null;
}

export function getContainerDescriptor(container?: string | null): {
  container: string | null;
  label: string;
  category: ContainerCategory;
  mimeHint: string;
} {
  const normalized = normalizeContainerFormat(container);
  if (normalized && CONTAINER_CATALOG[normalized]) {
    return {
      container: normalized,
      ...CONTAINER_CATALOG[normalized],
    };
  }
  return {
    container: normalized,
    label: normalized ? `${normalized} Media` : 'Unverified Container',
    category: 'unknown',
    mimeHint: 'application/octet-stream',
  };
}

export function identifyContainerFromUrl(rawUrl: string): {
  container: string | null;
  category: ContainerCategory;
  source: 'path_extension' | 'query_hint' | 'none';
} {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { container: null, category: 'unknown', source: 'none' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { container: null, category: 'unknown', source: 'none' };
  }

  const ext = getDirectMediaExtension(parsed.pathname);
  const fromPath = normalizeContainerFormat(ext);
  if (fromPath) {
    return {
      container: fromPath,
      category: getContainerDescriptor(fromPath).category,
      source: 'path_extension',
    };
  }

  for (const key of QUERY_CONTAINER_KEYS) {
    const val = parsed.searchParams.get(key);
    const fromQuery = normalizeContainerFormat(val);
    if (fromQuery) {
      return {
        container: fromQuery,
        category: getContainerDescriptor(fromQuery).category,
        source: 'query_hint',
      };
    }
  }

  return { container: null, category: 'unknown', source: 'none' };
}

export function buildFormatVariants(
  rawFormats: string[],
  detectedContainer: string | null
): FormatVariantOption[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const raw of rawFormats) {
    const normalized = normalizeContainerFormat(raw) ?? raw.trim().toUpperCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }

  // Put automatically identified source container first so it leads available variants
  if (detectedContainer && seen.has(detectedContainer)) {
    ordered.sort((a, b) => {
      if (a === detectedContainer) return -1;
      if (b === detectedContainer) return 1;
      return 0;
    });
  }

  return ordered.map((container) => {
    const desc = getContainerDescriptor(container);
    const isSourceContainer = Boolean(
      detectedContainer && container === detectedContainer
    );
    return {
      container,
      label: desc.label,
      category: desc.category,
      mimeHint: desc.mimeHint,
      isSourceContainer,
      requiresConversion: Boolean(
        detectedContainer && container !== detectedContainer
      ),
    };
  });
}

export interface AnalysisContainerSelection {
  detectedContainer: string | null;
  detectedCategory: ContainerCategory;
  defaultSelectedFormat: string;
  variants: FormatVariantOption[];
  selectionSource:
    | 'detected_container'
    | 'user_preference'
    | 'first_available'
    | 'unverified';
}

export function resolveAnalysisContainerSelection(
  analysis: Pick<
    AnalyzeResponse,
    | 'normalizedUrl'
    | 'capabilities'
    | 'availableFormats'
    | 'permittedOutputFormats'
    | 'directMediaVerification'
    | 'detectedContainer'
  >,
  preferredFormat?: FormatPreference | string
): AnalysisContainerSelection {
  const isDirectDownloadSupported =
    analysis.capabilities.actualDownloadAvailability === 'supported';

  const rawFormats =
    isDirectDownloadSupported &&
    Array.isArray(analysis.permittedOutputFormats) &&
    analysis.permittedOutputFormats.length > 0
      ? analysis.permittedOutputFormats
      : analysis.availableFormats;

  const fromVerifiedMime = normalizeContainerFormat(
    analysis.directMediaVerification?.verifiedMimeType
  );
  const fromExplicit = normalizeContainerFormat(analysis.detectedContainer);
  const fromExpected = normalizeContainerFormat(
    analysis.directMediaVerification?.expectedContainer
  );
  const fromUrl = isDirectDownloadSupported
    ? identifyContainerFromUrl(analysis.normalizedUrl).container
    : null;
  const fromSingleAvailable =
    rawFormats.length === 1 ? normalizeContainerFormat(rawFormats[0]) : null;

  const detectedContainer =
    fromVerifiedMime ??
    fromExplicit ??
    fromExpected ??
    fromUrl ??
    fromSingleAvailable ??
    null;

  const detectedCategory = getContainerDescriptor(detectedContainer).category;
  const variants = buildFormatVariants(rawFormats, detectedContainer);
  const variantContainers = new Set(variants.map((v) => v.container));

  if (variants.length === 0) {
    return {
      detectedContainer,
      detectedCategory,
      defaultSelectedFormat: 'Unverified',
      variants: [],
      selectionSource: 'unverified',
    };
  }

  if (detectedContainer && variantContainers.has(detectedContainer)) {
    return {
      detectedContainer,
      detectedCategory,
      defaultSelectedFormat: detectedContainer,
      variants,
      selectionSource: 'detected_container',
    };
  }

  const normalizedPref = normalizeContainerFormat(preferredFormat);
  if (normalizedPref && variantContainers.has(normalizedPref)) {
    return {
      detectedContainer,
      detectedCategory,
      defaultSelectedFormat: normalizedPref,
      variants,
      selectionSource: 'user_preference',
    };
  }

  return {
    detectedContainer,
    detectedCategory,
    defaultSelectedFormat: variants[0].container,
    variants,
    selectionSource: 'first_available',
  };
}
