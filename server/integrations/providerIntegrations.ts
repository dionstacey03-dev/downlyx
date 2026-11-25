import type { PlatformId } from '../../src/types/media.ts';

export type EligibleDirectFormat =
  | 'MP4'
  | 'WEBM'
  | 'MOV'
  | 'MP3'
  | 'WAV'
  | 'M4A'
  | 'OGG'
  | 'PNG'
  | 'JPEG'
  | 'WEBP';

export const ELIGIBLE_DIRECT_VIDEO_FORMATS: EligibleDirectFormat[] = [
  'MP4',
  'WEBM',
  'MOV',
  'MP3',
  'M4A',
  'WAV',
  'OGG',
];

export const ELIGIBLE_DIRECT_AUDIO_FORMATS: EligibleDirectFormat[] = [
  'MP3',
  'M4A',
  'WAV',
  'OGG',
];

export const ELIGIBLE_DIRECT_IMAGE_FORMATS: EligibleDirectFormat[] = [
  'PNG',
  'JPEG',
  'WEBP',
];

export const ALL_ELIGIBLE_DIRECT_FORMATS = new Set<string>([
  'MP4',
  'WEBM',
  'MOV',
  'MP3',
  'WAV',
  'M4A',
  'OGG',
  'PNG',
  'JPEG',
  'WEBP',
]);

export function normalizeDirectFormat(ext: string | null | undefined): string {
  const upper = (ext ?? '').trim().toUpperCase();
  if (upper === 'JPG') return 'JPEG';
  return upper;
}

export function getPermittedDirectOutputFormats(
  mediaType: string,
  expectedExt: string | null | undefined
): string[] {
  const norm = normalizeDirectFormat(expectedExt);
  if (mediaType === 'Audio') {
    return ELIGIBLE_DIRECT_AUDIO_FORMATS;
  }
  if (mediaType === 'Image') {
    if (ELIGIBLE_DIRECT_IMAGE_FORMATS.includes(norm as EligibleDirectFormat)) {
      return [norm];
    }
    return ELIGIBLE_DIRECT_IMAGE_FORMATS;
  }
  if (mediaType === 'Video') {
    return ELIGIBLE_DIRECT_VIDEO_FORMATS;
  }
  return [];
}

export interface ProviderDownloadAuthorization {
  authorized: boolean;
  reason: string;
}

export function checkProviderDownloadAuthorization(params: {
  platform: PlatformId;
  mediaType: string;
  userConfirmedPermission: boolean;
}): ProviderDownloadAuthorization {
  if (!params.userConfirmedPermission) {
    return {
      authorized: false,
      reason:
        'You must confirm that you own this media or have explicit permission to download it.',
    };
  }

  switch (params.platform) {
    case 'direct':
      return {
        authorized: true,
        reason:
          'Direct HTTPS media resource eligible for isolated worker inspection and download.',
      };
    case 'youtube':
      // YouTube downloads must remain disabled unless expressly approved by YouTube.
      return {
        authorized: false,
        reason:
          'YouTube downloads are disabled unless expressly approved by YouTube.',
      };
    case 'instagram':
      return {
        authorized: false,
        reason:
          params.mediaType === 'Story'
            ? 'Instagram Stories are restricted and are never accessed or bypassed.'
            : 'Instagram retrieval requires official authorized Meta Graph API integration.',
      };
    case 'tiktok':
      return {
        authorized: false,
        reason:
          'TikTok retrieval requires official authorized TikTok API credentials.',
      };
    case 'facebook':
      return {
        authorized: false,
        reason:
          'Facebook retrieval requires official authorized Meta API credentials.',
      };
    case 'x':
      return {
        authorized: false,
        reason:
          'X / Twitter retrieval requires official authorized X API credentials.',
      };
    default:
      return {
        authorized: false,
        reason: 'Unsupported source cannot be downloaded.',
      };
  }
}
