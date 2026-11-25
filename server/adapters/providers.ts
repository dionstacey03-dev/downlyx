import type { CapabilityMatrix } from '../../src/types/media.ts';
import {
  PLATFORM_HOST_ALLOWLISTS,
  type PlatformPatternMatch,
} from '../../src/utils/platformDetector.ts';
import { safePinnedProviderFetch } from '../security/urlSecurity.ts';
import {
  getPermittedDirectOutputFormats,
} from '../integrations/providerIntegrations.ts';
import type { ProviderAdapter } from './types.ts';

interface OEmbedPayload extends Record<string, unknown> {
  title?: unknown;
  author_name?: unknown;
  provider_name?: unknown;
  thumbnail_url?: unknown;
}

export const youtubeAdapter: ProviderAdapter = {
  id: 'youtube',
  name: 'YouTube',
  async fetchAuthorizedMetadata(normalizedUrl, _match, options) {
    if (options?.skipNetwork) {
      return {
        metadataStatus: 'unavailable',
        verifiedFormats: [],
        warnings: [
          'Network metadata lookup skipped; YouTube downloads remain disabled unless expressly approved by YouTube.',
        ],
      };
    }

    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      normalizedUrl
    )}&format=json`;
    const res = await safePinnedProviderFetch<OEmbedPayload>({
      providerId: 'youtube',
      endpointUrl: endpoint,
    });

    if (!res.ok || !res.data) {
      return {
        metadataStatus: 'unavailable',
        verifiedFormats: [],
        warnings: [
          res.warning || 'YouTube oEmbed metadata lookup unavailable.',
          'YouTube downloads remain disabled unless expressly approved by YouTube.',
        ],
      };
    }

    return {
      metadataStatus: 'available',
      metadata: {
        title:
          typeof res.data.title === 'string' ? res.data.title.slice(0, 200) : undefined,
        authorName:
          typeof res.data.author_name === 'string'
            ? res.data.author_name.slice(0, 120)
            : undefined,
        thumbnailUrl:
          typeof res.data.thumbnail_url === 'string' &&
          res.data.thumbnail_url.startsWith('https://')
            ? res.data.thumbnail_url
            : undefined,
        providerName: 'YouTube',
      },
      verifiedFormats: [],
      warnings: [
        'YouTube downloads remain disabled unless expressly approved by YouTube. Stream formats and resolutions are not enumerated.',
      ],
    };
  },
  getCapabilities(_match, metadataResult): CapabilityMatrix {
    return {
      urlDetection: 'supported',
      metadataAvailability:
        metadataResult.metadataStatus === 'available'
          ? 'supported'
          : 'not_available',
      authorizedMediaRetrieval: 'restricted',
      actualDownloadAvailability: 'not_available',
    };
  },
  resolveQualityOptions() {
    // YouTube downloads are disabled unless expressly approved by YouTube
    return [];
  },
};

export const instagramAdapter: ProviderAdapter = {
  id: 'instagram',
  name: 'Instagram',
  async fetchAuthorizedMetadata(_normalizedUrl, match) {
    if (match.isStory) {
      return {
        metadataStatus: 'restricted',
        verifiedFormats: [],
        warnings: [
          'Instagram Stories are private, ephemeral, or login-gated and are never accessed or bypassed.',
        ],
      };
    }

    return {
      metadataStatus: 'requires_authorization',
      verifiedFormats: [],
      warnings: [
        'Instagram metadata and media retrieval require authorized Meta Graph API credentials. Private accounts are never accessed.',
      ],
    };
  },
  getCapabilities(match): CapabilityMatrix {
    if (match.isStory) {
      return {
        urlDetection: 'supported',
        metadataAvailability: 'restricted',
        authorizedMediaRetrieval: 'restricted',
        actualDownloadAvailability: 'not_available',
      };
    }
    return {
      urlDetection: 'supported',
      metadataAvailability: 'requires_authorization',
      authorizedMediaRetrieval: 'requires_authorization',
      actualDownloadAvailability: 'not_available',
    };
  },
  resolveQualityOptions() {
    return [];
  },
};

export const tiktokAdapter: ProviderAdapter = {
  id: 'tiktok',
  name: 'TikTok',
  async fetchAuthorizedMetadata(normalizedUrl, _match, options) {
    let parsedHost = '';
    try {
      parsedHost = new URL(normalizedUrl).hostname.toLowerCase();
    } catch {
      parsedHost = '';
    }

    if (parsedHost === 'vm.tiktok.com' || parsedHost === 'vt.tiktok.com') {
      return {
        metadataStatus: 'unavailable',
        verifiedFormats: [],
        warnings: [
          'TikTok short links are recognized without following redirects to prevent redirect-based SSRF.',
        ],
      };
    }

    if (options?.skipNetwork || !PLATFORM_HOST_ALLOWLISTS.tiktok.has(parsedHost)) {
      return {
        metadataStatus: 'unavailable',
        verifiedFormats: [],
        warnings: [
          'TikTok oEmbed metadata lookup unavailable; no stream formats were inferred.',
        ],
      };
    }

    const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(
      normalizedUrl
    )}`;
    const res = await safePinnedProviderFetch<OEmbedPayload>({
      providerId: 'tiktok',
      endpointUrl: endpoint,
    });

    if (!res.ok || !res.data) {
      return {
        metadataStatus: 'unavailable',
        verifiedFormats: [],
        warnings: [
          res.warning || 'TikTok oEmbed metadata lookup unavailable.',
          'Authorized retrieval requires provider credentials.',
        ],
      };
    }

    return {
      metadataStatus: 'available',
      metadata: {
        title:
          typeof res.data.title === 'string' ? res.data.title.slice(0, 200) : undefined,
        authorName:
          typeof res.data.author_name === 'string'
            ? res.data.author_name.slice(0, 120)
            : undefined,
        thumbnailUrl:
          typeof res.data.thumbnail_url === 'string' &&
          res.data.thumbnail_url.startsWith('https://')
            ? res.data.thumbnail_url
            : undefined,
        providerName: 'TikTok',
      },
      verifiedFormats: [],
      warnings: [
        'Metadata verified via TikTok oEmbed. Stream formats and media retrieval require authorized provider access.',
      ],
    };
  },
  getCapabilities(_match, metadataResult): CapabilityMatrix {
    return {
      urlDetection: 'supported',
      metadataAvailability:
        metadataResult.metadataStatus === 'available'
          ? 'supported'
          : 'not_available',
      authorizedMediaRetrieval: 'requires_authorization',
      actualDownloadAvailability: 'not_available',
    };
  },
  resolveQualityOptions() {
    return [];
  },
};

export const facebookAdapter: ProviderAdapter = {
  id: 'facebook',
  name: 'Facebook',
  async fetchAuthorizedMetadata() {
    return {
      metadataStatus: 'requires_authorization',
      verifiedFormats: [],
      warnings: [
        'Facebook Watch and Reel metadata require an authorized Meta app token. Private or friends-only posts are never accessed.',
      ],
    };
  },
  getCapabilities(): CapabilityMatrix {
    return {
      urlDetection: 'supported',
      metadataAvailability: 'requires_authorization',
      authorizedMediaRetrieval: 'requires_authorization',
      actualDownloadAvailability: 'not_available',
    };
  },
  resolveQualityOptions() {
    return [];
  },
};

export const xAdapter: ProviderAdapter = {
  id: 'x',
  name: 'X / Twitter',
  async fetchAuthorizedMetadata() {
    return {
      metadataStatus: 'requires_authorization',
      verifiedFormats: [],
      warnings: [
        'X / Twitter post metadata and media variants require authorized X API credentials.',
      ],
    };
  },
  getCapabilities(): CapabilityMatrix {
    return {
      urlDetection: 'supported',
      metadataAvailability: 'requires_authorization',
      authorizedMediaRetrieval: 'requires_authorization',
      actualDownloadAvailability: 'not_available',
    };
  },
  resolveQualityOptions() {
    return [];
  },
};

export const directMediaAdapter: ProviderAdapter = {
  id: 'direct',
  name: 'Direct Media URL',
  async fetchAuthorizedMetadata(_normalizedUrl, match) {
    const ext = match.directExtension ?? null;
    const permittedOutputFormats = getPermittedDirectOutputFormats(
      match.mediaType,
      ext
    );
    // Do NOT trust URL file extensions alone and never fetch arbitrary user URLs from API server.
    return {
      metadataStatus: 'unavailable',
      verifiedFormats: [],
      permittedOutputFormats,
      directMediaVerification: {
        classification: 'probable_media_url',
        expectedContainer: ext,
        verifiedMimeType: null,
        signatureVerified: false,
        reason:
          'Probable media URL identified from HTTPS path extension only. Actual MIME type, binary magic-byte signature, and container metadata are verified exclusively inside the isolated download worker.',
      },
      warnings: [
        `Probable ${ext ?? 'media'} URL detected from path extension, not yet verified.`,
        'Isolated download worker will verify MIME type, binary signature, and FFprobe container integrity when you confirm ownership or permission.',
      ],
    };
  },
  getCapabilities(): CapabilityMatrix {
    return {
      urlDetection: 'supported',
      metadataAvailability: 'not_available',
      authorizedMediaRetrieval: 'supported',
      actualDownloadAvailability: 'supported',
    };
  },
  resolveQualityOptions() {
    // Never treat an unverified URL extension as verified media quality tier
    return [];
  },
};

export const PROVIDER_ADAPTERS: Record<
  Exclude<PlatformPatternMatch['platform'], 'unsupported'>,
  ProviderAdapter
> = {
  youtube: youtubeAdapter,
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
  facebook: facebookAdapter,
  x: xAdapter,
  direct: directMediaAdapter,
};
