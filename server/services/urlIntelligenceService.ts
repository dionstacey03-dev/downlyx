import type { AnalyzeResponse } from '../../src/types/media.ts';
import {
  detectPlatformPattern,
  validateExternalHttpsUrl,
} from '../../src/utils/platformDetector.ts';
import { resolveAnalysisContainerSelection } from '../../src/utils/containerFormat.ts';
import { PROVIDER_ADAPTERS } from '../adapters/providers.ts';

export interface AnalyzeOptions {
  skipNetworkMetadata?: boolean;
}

function logAnalysisEvent(entry: {
  status: string;
  platform: string;
  hostname: string;
  reason?: string;
}) {
  if (process.env.NODE_ENV === 'test') return;
  console.info(
    `[URL-INTELLIGENCE] status=${entry.status} platform=${entry.platform} host=${entry.hostname || 'none'}${entry.reason ? ` reason="${entry.reason}"` : ''}`
  );
}

export async function analyzeUrlIntelligence(
  rawUrl: string,
  options?: AnalyzeOptions
): Promise<{ httpStatus: number; payload: AnalyzeResponse }> {
  const analyzedAt = new Date().toISOString();
  const security = validateExternalHttpsUrl(rawUrl);

  if (!security.valid || !security.parsed) {
    logAnalysisEvent({
      status: security.validationStatus,
      platform: 'unsupported',
      hostname: security.hostname,
      reason: security.error,
    });

    return {
      httpStatus: 400,
      payload: {
        success: false,
        platform: 'unsupported',
        platformName:
          security.validationStatus === 'blocked' ? 'Blocked URL' : 'Invalid URL',
        normalizedUrl: security.normalizedUrl,
        hostname: security.hostname,
        mediaType: 'Unknown',
        resourceId: null,
        validationStatus: security.validationStatus,
        capabilities: {
          urlDetection: 'not_available',
          metadataAvailability: 'not_available',
          authorizedMediaRetrieval: 'not_available',
          actualDownloadAvailability: 'not_available',
        },
        availableFormats: [],
        qualityOptions: [],
        metadataStatus: 'unavailable',
        warnings: security.warnings,
        error: security.error || 'URL validation failed.',
        analyzedAt,
      },
    };
  }

  const pattern = detectPlatformPattern(security.parsed);

  // Valid HTTPS URL, but unsupported domain or missing resource path
  if (!pattern.isSupportedPattern || pattern.platform === 'unsupported') {
    logAnalysisEvent({
      status: 'unsupported',
      platform: pattern.platform,
      hostname: security.hostname,
      reason: pattern.patternError,
    });

    return {
      httpStatus: 200,
      payload: {
        success: false,
        platform: pattern.platform,
        platformName: pattern.platformName,
        normalizedUrl: security.normalizedUrl,
        hostname: security.hostname,
        mediaType: pattern.mediaType,
        resourceId: pattern.resourceId,
        validationStatus: 'unsupported',
        capabilities: {
          urlDetection:
            pattern.platform === 'unsupported' ? 'not_available' : 'supported',
          metadataAvailability: 'not_available',
          authorizedMediaRetrieval: 'not_available',
          actualDownloadAvailability: 'not_available',
        },
        availableFormats: [],
        qualityOptions: [],
        metadataStatus: 'unavailable',
        warnings: [
          pattern.patternError ||
            'Domain or URL structure is not supported by DOWNLYX.',
        ],
        error:
          pattern.patternError ||
          'Unsupported platform or missing media identifier.',
        analyzedAt,
      },
    };
  }

  const adapter = PROVIDER_ADAPTERS[pattern.platform];
  const metadataResult = await adapter.fetchAuthorizedMetadata(
    security.normalizedUrl,
    pattern,
    { skipNetwork: options?.skipNetworkMetadata }
  );
  const capabilities = adapter.getCapabilities(pattern, metadataResult);
  const qualityOptions = adapter.resolveQualityOptions(pattern, metadataResult);

  // Instagram Stories are recognized for URL detection only, never authorized/supported for retrieval
  const isStoryRestricted = Boolean(pattern.isStory);

  logAnalysisEvent({
    status: isStoryRestricted ? 'restricted' : 'valid',
    platform: pattern.platform,
    hostname: security.hostname,
  });

  const containerSelection = isStoryRestricted
    ? { detectedContainer: null, variants: [] }
    : resolveAnalysisContainerSelection({
        normalizedUrl: security.normalizedUrl,
        capabilities,
        availableFormats: metadataResult.verifiedFormats,
        permittedOutputFormats: metadataResult.permittedOutputFormats,
        directMediaVerification: metadataResult.directMediaVerification,
      });

  return {
    httpStatus: 200,
    payload: {
      success: !isStoryRestricted,
      platform: pattern.platform,
      platformName: adapter.name,
      normalizedUrl: security.normalizedUrl,
      hostname: security.hostname,
      mediaType: pattern.mediaType,
      resourceId: pattern.resourceId,
      validationStatus: isStoryRestricted ? 'unsupported' : 'valid',
      capabilities,
      availableFormats: metadataResult.verifiedFormats,
      permittedOutputFormats: metadataResult.permittedOutputFormats,
      detectedContainer: containerSelection.detectedContainer,
      formatVariants: containerSelection.variants,
      qualityOptions,
      metadataStatus: metadataResult.metadataStatus,
      metadata: metadataResult.metadata,
      directMediaVerification: metadataResult.directMediaVerification,
      warnings: metadataResult.warnings,
      error: isStoryRestricted
        ? 'Instagram Stories are restricted and cannot be accessed or retrieved.'
        : null,
      analyzedAt,
    },
  };
}
