import type {
  CapabilityMatrix,
  DirectMediaVerification,
  MediaMetadataSummary,
  MetadataStatus,
  PlatformId,
  QualityOption,
} from '../../src/types/media.ts';
import type { PlatformPatternMatch } from '../../src/utils/platformDetector.ts';

export interface ProviderMetadataResult {
  metadataStatus: MetadataStatus;
  metadata?: MediaMetadataSummary;
  directMediaVerification?: DirectMediaVerification;
  verifiedFormats: string[];
  permittedOutputFormats?: string[];
  supportsStandard?: boolean;
  supportsAudio?: boolean;
  warnings: string[];
}

export interface ProviderAdapter {
  id: Exclude<PlatformId, 'unsupported'>;
  name: string;
  getCapabilities(
    match: PlatformPatternMatch,
    metadataResult: ProviderMetadataResult
  ): CapabilityMatrix;
  fetchAuthorizedMetadata(
    normalizedUrl: string,
    match: PlatformPatternMatch,
    options?: { skipNetwork?: boolean }
  ): Promise<ProviderMetadataResult>;
  resolveQualityOptions(
    match: PlatformPatternMatch,
    metadataResult: ProviderMetadataResult
  ): QualityOption[];
}

export function buildVerifiedQualityOptions(params: {
  permitted: boolean;
  hasVerifiedFormats: boolean;
  isAudioOnly: boolean;
  supportsStandard?: boolean;
  supportsAudio?: boolean;
  sourceNote: string;
}): QualityOption[] {
  if (!params.permitted || !params.hasVerifiedFormats) {
    return [];
  }

  if (params.isAudioOnly) {
    return [
      {
        id: 'audio',
        label: 'Audio',
        note: params.sourceNote,
      },
    ];
  }

  const options: QualityOption[] = [
    {
      id: 'best',
      label: 'Best Available',
      note: params.sourceNote,
    },
  ];

  if (params.supportsStandard) {
    options.push({
      id: 'standard',
      label: 'Standard',
      note: 'Standard stream tier verified by provider metadata.',
    });
  }

  if (params.supportsAudio) {
    options.push({
      id: 'audio',
      label: 'Audio',
      note: 'Audio-only extraction permitted and verified by provider.',
    });
  }

  return options;
}
