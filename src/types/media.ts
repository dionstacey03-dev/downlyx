export type NavPage = 'home' | 'downloads' | 'platforms' | 'settings' | 'help';

export type ThemeMode = 'dark' | 'light';

export type QualityPreference = 'best' | 'standard' | 'audio';

export type FormatPreference = 'mp4' | 'webm' | 'mp3' | 'm4a';

export type PlatformId =
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'facebook'
  | 'x'
  | 'direct'
  | 'unsupported';

export type MediaTypeLabel =
  | 'Video'
  | 'Short Video'
  | 'Reel'
  | 'Story'
  | 'Post Media'
  | 'Audio'
  | 'Image'
  | 'Direct Asset'
  | 'Unknown';

export type DownloadJobStatus =
  | 'queued'
  | 'processing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'permanently_failed'
  | 'cancelled';

export type DownloadStatus =
  | 'analyzed'
  | 'queued'
  | 'processing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'permanently_failed'
  | 'cancelled'
  | 'unsupported';

export type CapabilityStatus =
  | 'supported'
  | 'restricted'
  | 'requires_authorization'
  | 'not_available'
  | 'unknown';

export type ValidationStatus =
  | 'valid'
  | 'invalid'
  | 'blocked'
  | 'unsupported';

export type MetadataStatus =
  | 'available'
  | 'unavailable'
  | 'requires_authorization'
  | 'restricted';

export interface QualityOption {
  id: string;
  label: string;
  note: string;
}

export interface CapabilityMatrix {
  urlDetection: CapabilityStatus;
  metadataAvailability: CapabilityStatus;
  authorizedMediaRetrieval: CapabilityStatus;
  actualDownloadAvailability: CapabilityStatus;
}

export interface MediaMetadataSummary {
  title?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  authorName?: string;
  providerName?: string;
}

export interface DirectMediaVerification {
  classification: 'probable_media_url' | 'verified_media_file' | 'unverified';
  expectedContainer: string | null;
  verifiedMimeType: string | null;
  signatureVerified: boolean;
  reason: string;
}

export type ContainerCategory = 'video' | 'audio' | 'image' | 'unknown';

export interface FormatVariantOption {
  container: string;
  label: string;
  category: ContainerCategory;
  mimeHint: string;
  isSourceContainer: boolean;
  requiresConversion: boolean;
}

export interface AnalyzeResponse {
  success: boolean;
  platform: PlatformId;
  platformName: string;
  normalizedUrl: string;
  hostname: string;
  mediaType: MediaTypeLabel;
  resourceId: string | null;
  validationStatus: ValidationStatus;
  capabilities: CapabilityMatrix;
  availableFormats: string[];
  permittedOutputFormats?: string[];
  detectedContainer?: string | null;
  formatVariants?: FormatVariantOption[];
  qualityOptions: QualityOption[];
  metadataStatus: MetadataStatus;
  metadata?: MediaMetadataSummary;
  directMediaVerification?: DirectMediaVerification;
  warnings: string[];
  error: string | null;
  analyzedAt: string;
}

export interface VerifiedMediaMetadata {
  container: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  resolutionLabel?: string;
  videoCodec?: string;
  audioCodec?: string;
}

export interface DownloadJob {
  id: string;
  url: string;
  platform: PlatformId;
  platformName: string;
  mediaType: MediaTypeLabel;
  targetFormat: string;
  status: DownloadJobStatus;
  progressPercent: number | null;
  bytesDownloaded: number;
  totalBytes: number | null;
  stageMessage: string;
  verifiedMetadata?: VerifiedMediaMetadata;
  downloadUrl?: string;
  downloadToken?: string;
  expiresAt?: string;
  error?: string;
  retryCount?: number;
  maxRetries?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformCapabilityItem {
  label: string;
  state: string;
  status: CapabilityStatus;
}

export interface PlatformCapabilities {
  urlDetection: PlatformCapabilityItem;
  metadataAvailability: PlatformCapabilityItem;
  authorizedRetrieval: PlatformCapabilityItem;
  downloadAvailability: PlatformCapabilityItem;
}

export interface PlatformSpec {
  id: Exclude<PlatformId, 'unsupported'>;
  name: string;
  shortLabel: string;
  tagline: string;
  domains: string[];
  supportedTypes: string[];
  formatOptions: string[];
  qualityTiers: string[];
  exampleUrl: string;
  patternSummary: string;
  phaseNote: string;
  capabilities: PlatformCapabilities;
  storyNote?: string;
}

export interface HistoryItem {
  id: string;
  url: string;
  platform: PlatformId;
  platformName: string;
  mediaType: MediaTypeLabel;
  fileType: string;
  qualityPreference: string;
  status: DownloadStatus;
  resourceId: string | null;
  createdAt: string;
  note: string;
  jobId?: string;
  sizeBytes?: number;
  downloadUrl?: string;
  expiresAt?: string;
  retryCount?: number;
  maxRetries?: number;
}

export interface UserPreferences {
  defaultQuality: QualityPreference;
  defaultFormat: FormatPreference;
  autoDetectClipboard: boolean;
  saveHistoryLocally: boolean;
  autoRetry: boolean;
  workspaceName: string;
}
