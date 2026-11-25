import React, { useMemo, useRef, useState } from 'react';
import {
  ClipboardPaste,
  Search,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  BookmarkPlus,
  ArrowRight,
  ShieldCheck,
  Sliders,
  Layers,
  Inbox,
  Info,
  AlertTriangle,
  Lock,
  Clock,
  Download,
  FileCheck2,
  Ban,
} from 'lucide-react';
import type {
  AnalyzeResponse,
  CapabilityStatus,
  DownloadJob,
  HistoryItem,
  NavPage,
  UserPreferences,
} from '../types/media.ts';
import {
  SUPPORTED_PLATFORMS,
  detectPlatformQuick,
} from '../utils/platformDetector.ts';
import {
  getContainerDescriptor,
  resolveAnalysisContainerSelection,
} from '../utils/containerFormat.ts';
import { PlatformIcon } from '../components/PlatformIcon.tsx';
import { StatusIndicator } from '../components/StatusIndicator.tsx';
import { Tooltip } from '../components/Tooltip.tsx';
import { LoadingState } from '../components/LoadingState.tsx';

interface HomePageProps {
  urlInput: string;
  onChangeUrlInput: (val: string) => void;
  preferences: UserPreferences;
  recentHistory: HistoryItem[];
  downloadJobs: DownloadJob[];
  onStartDownload: (params: {
    url: string;
    targetFormat: string;
    userConfirmedPermission: boolean;
    qualityPreference: string;
  }) => Promise<{ ok: true; job: DownloadJob } | { ok: false; error: string }>;
  onCancelDownload: (jobId: string) => Promise<void>;
  onDownloadFile: (
    jobId: string,
    fallbackContainer?: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSaveToHistory: (
    url: string,
    fileType: string,
    qualityPreference: string
  ) => Promise<HistoryItem | null>;
  onNavigate: (page: NavPage) => void;
}

const CAPABILITY_LABELS: Record<CapabilityStatus, string> = {
  supported: 'Supported',
  restricted: 'Restricted',
  requires_authorization: 'Requires Authorization',
  not_available: 'Not Available',
  unknown: 'Unknown',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderCapabilityBadge(status: CapabilityStatus) {
  if (status === 'supported') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{CAPABILITY_LABELS[status]}</span>
      </span>
    );
  }
  if (status === 'restricted' || status === 'requires_authorization') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{CAPABILITY_LABELS[status]}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{CAPABILITY_LABELS[status]}</span>
    </span>
  );
}

export const HomePage: React.FC<HomePageProps> = ({
  urlInput,
  onChangeUrlInput,
  preferences,
  recentHistory,
  downloadJobs,
  onStartDownload,
  onCancelDownload,
  onDownloadFile,
  onSaveToHistory,
  onNavigate,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [clipboardFeedback, setClipboardFeedback] = useState<string | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>('Pending');
  const [selectedQualityLabel, setSelectedQualityLabel] =
    useState<string>('Best Available');
  const [userConfirmedPermission, setUserConfirmedPermission] = useState(false);
  const [isStartingDownload, setIsStartingDownload] = useState(false);
  const [downloadSubmitError, setDownloadSubmitError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  const liveDetection = useMemo(
    () => detectPlatformQuick(urlInput),
    [urlInput]
  );

  const activeJob = useMemo(
    () => (activeJobId ? downloadJobs.find((j) => j.id === activeJobId) ?? null : null),
    [activeJobId, downloadJobs]
  );

  const containerSelection = useMemo(
    () =>
      analysis
        ? resolveAnalysisContainerSelection(analysis, preferences.defaultFormat)
        : null,
    [analysis, preferences.defaultFormat]
  );

  const selectableFormats = useMemo(() => {
    if (!analysis || !containerSelection) return [];
    if (containerSelection.variants.length > 0) {
      return containerSelection.variants.map((v) => v.container);
    }
    return analysis.availableFormats;
  }, [analysis, containerSelection]);

  const formatVariants = containerSelection?.variants ?? [];
  const selectedFormatDescriptor = useMemo(
    () => getContainerDescriptor(selectedFormat),
    [selectedFormat]
  );

  const canDownload = Boolean(
    analysis &&
      analysis.success &&
      analysis.capabilities.actualDownloadAvailability === 'supported' &&
      selectableFormats.length > 0
  );

  const runAnalysis = async (targetUrl?: string) => {
    const query = (targetUrl ?? urlInput).trim();
    setErrorMsg(null);
    setSavedNotice(false);
    setClipboardFeedback(null);
    setThumbError(false);
    setUserConfirmedPermission(false);
    setDownloadSubmitError(null);
    setActiveJobId(null);

    if (!query) {
      setAnalysis(null);
      setErrorMsg('Enter or paste an HTTPS media URL before selecting Analyze.');
      inputRef.current?.focus();
      return;
    }

    setIsAnalyzing(true);
    setAnalysis(null);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: query }),
      });

      const data = (await response.json()) as AnalyzeResponse;

      if (
        !response.ok ||
        data.validationStatus === 'invalid' ||
        data.validationStatus === 'blocked'
      ) {
        setErrorMsg(data.error || 'Unable to validate this URL.');
        setAnalysis(null);
      } else {
        setAnalysis(data);
        const resolvedContainer = resolveAnalysisContainerSelection(
          data,
          preferences.defaultFormat
        );
        setSelectedFormat(resolvedContainer.defaultSelectedFormat);

        if (data.qualityOptions.length > 0) {
          const matchingPref = data.qualityOptions.find(
            (opt) => opt.id === preferences.defaultQuality
          );
          setSelectedQualityLabel(
            (matchingPref ?? data.qualityOptions[0]).label
          );
        } else if (data.capabilities.actualDownloadAvailability === 'supported') {
          setSelectedQualityLabel('Original Verified Asset');
        } else {
          setSelectedQualityLabel('Unavailable');
        }
      }
    } catch {
      setErrorMsg(
        'Could not reach the DOWNLYX URL Intelligence service. Check your connection and try again.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handlePaste = async () => {
    setClipboardFeedback(null);
    setErrorMsg(null);

    if (!navigator.clipboard || !navigator.clipboard.readText) {
      setClipboardFeedback(
        'Clipboard access is unavailable in this browser. Paste manually with Ctrl+V or Cmd+V.'
      );
      inputRef.current?.focus();
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardFeedback('Your clipboard is currently empty.');
        inputRef.current?.focus();
        return;
      }
      onChangeUrlInput(text.trim());
      setAnalysis(null);
      setSavedNotice(false);
      setActiveJobId(null);
      setDownloadSubmitError(null);
      inputRef.current?.focus();
    } catch {
      setClipboardFeedback(
        'Clipboard permission was declined. Paste directly into the URL field.'
      );
      inputRef.current?.focus();
    }
  };

  const handleFocusPaste = async () => {
    if (!preferences.autoDetectClipboard || urlInput.trim().length > 0) return;
    if (!navigator.clipboard?.readText) return;
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (trimmed.startsWith('https://')) {
        onChangeUrlInput(trimmed);
      }
    } catch {
      // Silent fallback if clipboard permission is not granted
    }
  };

  const handleClear = () => {
    onChangeUrlInput('');
    setAnalysis(null);
    setErrorMsg(null);
    setClipboardFeedback(null);
    setSavedNotice(false);
    setThumbError(false);
    setUserConfirmedPermission(false);
    setActiveJobId(null);
    setDownloadSubmitError(null);
    inputRef.current?.focus();
  };

  const handlePrependHttps = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    const updated = `https://${trimmed}`;
    onChangeUrlInput(updated);
    setErrorMsg(null);
    void runAnalysis(updated);
  };

  const handleStartAuthorizedDownload = async () => {
    if (!analysis || !canDownload) return;
    setDownloadSubmitError(null);
    if (!userConfirmedPermission) {
      setDownloadSubmitError(
        'Confirm ownership or explicit download authorization before starting.'
      );
      return;
    }

    setIsStartingDownload(true);
    const result = await onStartDownload({
      url: analysis.normalizedUrl,
      targetFormat: selectedFormat,
      userConfirmedPermission,
      qualityPreference: selectedQualityLabel,
    });
    setIsStartingDownload(false);

    if (!result.ok) {
      setDownloadSubmitError(result.error);
      return;
    }

    setActiveJobId(result.job.id);
    setSavedNotice(true);
  };

  const handleSaveQueue = async () => {
    if (!analysis) return;
    setIsSaving(true);
    const created = await onSaveToHistory(
      analysis.normalizedUrl,
      selectedFormat,
      selectedQualityLabel
    );
    setIsSaving(false);
    if (created) {
      setSavedNotice(true);
    }
  };

  const handleUseExample = (exampleUrl: string) => {
    onChangeUrlInput(exampleUrl);
    setErrorMsg(null);
    setClipboardFeedback(null);
    setSavedNotice(false);
    void runAnalysis(exampleUrl);
  };

  const isJobRunning =
    activeJob &&
    (activeJob.status === 'queued' ||
      activeJob.status === 'processing' ||
      activeJob.status === 'verifying');

  return (
    <div className="space-y-12">
      {/* Hero & Central Analyzer */}
      <section className="relative pt-2 sm:pt-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-12 left-1/2 -translate-x-1/2 h-64 w-full max-w-3xl rounded-full bg-gradient-to-r from-[#8B5CF6]/15 via-[#22D3EE]/10 to-transparent blur-3xl dark:from-[#8B5CF6]/20 dark:via-[#22D3EE]/12"
        />

        <div className="relative mx-auto max-w-3xl text-center space-y-4">
          <h1
            className="font-display font-bold tracking-tight text-slate-900 dark:text-white leading-[1.12]"
            style={{
              fontSize: 'clamp(1.85rem, 3.6vw, 3.15rem)',
              textWrap: 'balance',
            }}
          >
            Inspect and organize media links in one focused workspace
          </h1>
          <p className="mx-auto max-w-2xl text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed">
            Paste an HTTPS link from YouTube, Instagram, TikTok, Facebook, X, or
            a direct media asset to run URL security checks, capability
            inspection, and isolated authorized downloading.
          </p>
        </div>

        {/* Central URL Input Card */}
        <div className="relative mx-auto mt-8 max-w-3xl rounded-2xl border border-slate-200 bg-white/95 p-4 sm:p-6 shadow-sm backdrop-blur-xl dark:border-white/[0.09] dark:bg-[#111827]/85 dark:shadow-2xl dark:shadow-black/30">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runAnalysis();
            }}
            noValidate
            className="space-y-3.5"
          >
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="downlyx-url-input"
                className="text-xs font-medium text-slate-600 dark:text-slate-400"
              >
                Media URL
              </label>
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                HTTPS only
              </span>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1 min-w-0">
                <input
                  ref={inputRef}
                  id="downlyx-url-input"
                  type="url"
                  value={urlInput}
                  onFocus={() => void handleFocusPaste()}
                  onChange={(e) => {
                    onChangeUrlInput(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                    if (clipboardFeedback) setClipboardFeedback(null);
                    if (savedNotice) setSavedNotice(false);
                    if (downloadSubmitError) setDownloadSubmitError(null);
                  }}
                  placeholder="https://cdn.example.com/assets/sample-reel-1080p.mp4"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(errorMsg)}
                  className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 pl-4 pr-10 font-mono text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:border-[#8B5CF6] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#8B5CF6]/25 dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-[#8B5CF6] dark:focus:bg-[#080B14]"
                />
                {urlInput.length > 0 && (
                  <Tooltip content="Clear URL input">
                    <button
                      type="button"
                      onClick={handleClear}
                      aria-label="Clear URL input"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </Tooltip>
                )}
              </div>

              <div className="grid grid-cols-2 sm:flex items-center gap-2.5 shrink-0">
                <Tooltip content="Paste link from clipboard">
                  <button
                    type="button"
                    onClick={() => void handlePaste()}
                    className="inline-flex h-12 w-full sm:w-auto items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:bg-white/[0.08] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                  >
                    <ClipboardPaste className="h-4 w-4 text-[#22D3EE]" aria-hidden="true" />
                    <span>Paste URL</span>
                  </button>
                </Tooltip>

                <button
                  type="submit"
                  disabled={isAnalyzing}
                  className="inline-flex h-12 w-full sm:w-auto items-center justify-center gap-2 rounded-xl bg-[#8B5CF6] px-6 text-sm font-semibold text-white shadow-sm shadow-[#8B5CF6]/25 transition-colors hover:bg-[#7C3AED] disabled:opacity-60 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]"
                >
                  {isAnalyzing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      <span>Analyzing</span>
                    </>
                  ) : (
                    <>
                      <Search className="h-4 w-4" aria-hidden="true" />
                      <span>Analyze</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Live Platform Detection & Validation Feedback Strip */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs">
              {urlInput.trim().length === 0 ? (
                <span className="text-slate-500 dark:text-slate-400">
                  Real-time HTTPS URL validation and platform detection ready.
                </span>
              ) : liveDetection.isSupported ? (
                <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                  <PlatformIcon platform={liveDetection.platform} className="h-4 w-4 shrink-0" />
                  <span className="font-medium">{liveDetection.platformName}</span>
                  <span aria-hidden="true" className="text-slate-400">·</span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {liveDetection.mediaType} pattern recognized
                  </span>
                </div>
              ) : liveDetection.missingProtocolHint ? (
                <div className="flex flex-wrap items-center gap-2 text-amber-600 dark:text-amber-400">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Missing https:// prefix.</span>
                  <button
                    type="button"
                    onClick={handlePrependHttps}
                    className="font-semibold underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
                  >
                    Add https:// and analyze
                  </button>
                </div>
              ) : liveDetection.isBlocked ? (
                <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{liveDetection.message}</span>
                </div>
              ) : liveDetection.isValidUrl ? (
                <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {liveDetection.mediaType === 'Story'
                      ? 'Instagram Story URL recognized — private/expired Stories are restricted.'
                      : liveDetection.message || 'Unsupported domain or missing media ID.'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Enter a complete URL starting with https://</span>
                </div>
              )}

              {clipboardFeedback && (
                <span className="text-amber-600 dark:text-amber-400">
                  {clipboardFeedback}
                </span>
              )}
            </div>
          </form>

          {/* Consistent Loading State */}
          {isAnalyzing && (
            <div className="mt-6 border-t border-slate-200 dark:border-white/[0.08] pt-5">
              <LoadingState
                label="Running URL security checks, capability evaluation, and authorized metadata lookup..."
                rows={3}
              />
            </div>
          )}

          {/* Error State */}
          {!isAnalyzing && errorMsg && (
            <div
              role="alert"
              className="mt-6 border-t border-slate-200 dark:border-white/[0.08] pt-5"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50/70 p-4 text-sm text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-medium">URL validation could not proceed</p>
                    <p className="text-xs text-rose-700 dark:text-rose-300 leading-relaxed">
                      {errorMsg}
                    </p>
                  </div>
                </div>
                {liveDetection.missingProtocolHint && (
                  <button
                    type="button"
                    onClick={handlePrependHttps}
                    className="self-start sm:self-center rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 whitespace-nowrap shrink-0"
                  >
                    Prepend https://
                  </button>
                )}
              </div>
            </div>
          )}

          {/* URL Intelligence Analysis Result Panel */}
          {!isAnalyzing && analysis && (
            <div className="mt-6 border-t border-slate-200 dark:border-white/[0.08] pt-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.04]">
                    <PlatformIcon platform={analysis.platform} className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                      <span>{analysis.platformName}</span>
                      <span aria-hidden="true" className="text-slate-400">·</span>
                      <span className="font-normal text-slate-600 dark:text-slate-300">
                        {analysis.mediaType}
                      </span>
                    </div>
                    <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                      {analysis.normalizedUrl}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs shrink-0">
                  {analysis.success ? (
                    <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      <span>HTTPS Validated</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                      <span>
                        {analysis.mediaType === 'Story'
                          ? 'Restricted Story'
                          : 'Unsupported'}
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {/* Authorized Metadata Preview */}
              {analysis.metadata && (analysis.metadata.title || analysis.metadata.thumbnailUrl) && (
                <div className="flex flex-col sm:flex-row items-start gap-4 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-white/[0.08] dark:bg-[#080B14]/60">
                  {analysis.metadata.thumbnailUrl && !thumbError && (
                    <img
                      src={analysis.metadata.thumbnailUrl}
                      alt={analysis.metadata.title || 'Media thumbnail'}
                      referrerPolicy="no-referrer"
                      onError={() => setThumbError(true)}
                      className="h-20 w-36 rounded-lg object-cover shrink-0 border border-slate-200 dark:border-white/10"
                    />
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                      Authorized Metadata Verified
                    </p>
                    {analysis.metadata.title && (
                      <p className="text-sm font-semibold text-slate-900 dark:text-white leading-snug">
                        {analysis.metadata.title}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      {analysis.metadata.authorName && (
                        <span>{analysis.metadata.authorName}</span>
                      )}
                      {analysis.metadata.providerName && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{analysis.metadata.providerName}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Direct Media Probable vs Verified Classification */}
              {analysis.directMediaVerification && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/[0.08] dark:bg-[#080B14]/60 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      Direct Media Verification
                    </span>
                    <span
                      className={`font-medium ${
                        activeJob?.status === 'completed'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {activeJob?.status === 'completed' && activeJob.verifiedMetadata
                        ? 'Verified Media File'
                        : 'Probable Media URL (Pre-Worker)'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600 dark:text-slate-300">
                    <span>
                      Detected container:{' '}
                      <strong
                        data-testid="detected-container-value"
                        className="font-mono text-slate-900 dark:text-white"
                      >
                        {containerSelection?.detectedContainer ||
                          analysis.directMediaVerification.expectedContainer ||
                          'Unknown'}
                      </strong>
                    </span>
                    <span aria-hidden="true" className="text-slate-400">·</span>
                    <span>
                      MIME &amp; signature:{' '}
                      <strong className="text-slate-900 dark:text-white">
                        {activeJob?.status === 'completed' && activeJob.verifiedMetadata
                          ? `Verified (${activeJob.verifiedMetadata.mimeType})`
                          : 'Verified in isolated worker on download'}
                      </strong>
                    </span>
                  </div>
                  <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                    {analysis.directMediaVerification.reason}
                  </p>
                </div>
              )}

              {/* Core Inspection Grid */}
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-y border-slate-200 dark:border-white/[0.08] py-4 text-xs">
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Resource Identifier</dt>
                  <dd className="mt-1 font-mono font-medium text-slate-900 dark:text-slate-100 truncate">
                    {analysis.resourceId || 'Not available'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Metadata Status</dt>
                  <dd className="mt-1 font-medium capitalize text-slate-900 dark:text-slate-100">
                    {activeJob?.status === 'completed' && activeJob.verifiedMetadata
                      ? 'Verified by FFprobe'
                      : analysis.metadataStatus.replace(/_/g, ' ')}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">
                    {canDownload ? 'Permitted Output Formats' : 'Verified Formats'}
                  </dt>
                  <dd className="mt-1 font-mono font-medium text-slate-900 dark:text-slate-100">
                    {selectableFormats.length > 0
                      ? selectableFormats.join(', ')
                      : 'None verified'}
                  </dd>
                </div>
              </dl>

              {/* 4-Dimension Capability Status Matrix */}
              <div className="space-y-2.5">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                  Capability Status
                </p>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 dark:border-white/[0.08] dark:bg-[#080B14]/50">
                    <dt className="text-slate-600 dark:text-slate-300">URL Detection</dt>
                    <dd>{renderCapabilityBadge(analysis.capabilities.urlDetection)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 dark:border-white/[0.08] dark:bg-[#080B14]/50">
                    <dt className="text-slate-600 dark:text-slate-300">Metadata Availability</dt>
                    <dd>{renderCapabilityBadge(analysis.capabilities.metadataAvailability)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 dark:border-white/[0.08] dark:bg-[#080B14]/50">
                    <dt className="text-slate-600 dark:text-slate-300">Authorized Retrieval</dt>
                    <dd>{renderCapabilityBadge(analysis.capabilities.authorizedMediaRetrieval)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 dark:border-white/[0.08] dark:bg-[#080B14]/50">
                    <dt className="text-slate-600 dark:text-slate-300">Download Availability</dt>
                    <dd>{renderCapabilityBadge(analysis.capabilities.actualDownloadAvailability)}</dd>
                  </div>
                </dl>
              </div>

              {/* Formats & Quality Options */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                      {canDownload
                        ? 'Container & Format Variants'
                        : 'Available Formats'}
                    </p>
                    {containerSelection?.detectedContainer && (
                      <span className="font-mono text-[11px] font-medium text-[#7C3AED] dark:text-[#22D3EE]">
                        Auto-detected: {containerSelection.detectedContainer}
                      </span>
                    )}
                  </div>
                  {formatVariants.length > 0 ? (
                    <div className="space-y-2">
                      <div
                        data-testid="format-variants-group"
                        role="group"
                        aria-label="Available container format variants"
                        className="flex flex-wrap gap-1.5"
                      >
                        {formatVariants.map((variant) => {
                          const isSelected = selectedFormat === variant.container;
                          return (
                            <Tooltip
                              key={variant.container}
                              content={`${variant.label} (${variant.mimeHint})${
                                variant.isSourceContainer
                                  ? ' · Matches detected source container'
                                  : variant.requiresConversion
                                  ? ' · Converted via FFmpeg worker'
                                  : ''
                              }`}
                            >
                              <button
                                type="button"
                                data-format-variant={variant.container}
                                aria-pressed={isSelected}
                                onClick={() => setSelectedFormat(variant.container)}
                                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                                  isSelected
                                    ? 'bg-[#8B5CF6] text-white'
                                    : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.08]'
                                }`}
                              >
                                <span>{variant.container}</span>
                                {variant.isSourceContainer && (
                                  <span
                                    className={`text-[10px] font-sans font-normal ${
                                      isSelected
                                        ? 'text-white/85'
                                        : 'text-emerald-600 dark:text-emerald-400'
                                    }`}
                                  >
                                    (Source)
                                  </span>
                                )}
                              </button>
                            </Tooltip>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        Selected variant:{' '}
                        <span className="font-medium text-slate-700 dark:text-slate-200">
                          {selectedFormatDescriptor.label}
                        </span>{' '}
                        <span className="font-mono text-slate-400 dark:text-slate-500">
                          ({selectedFormatDescriptor.mimeHint})
                        </span>
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      No stream formats verified for this source.
                    </p>
                  )}
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-1.5">
                    <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                      Quality Options
                    </p>
                    <Tooltip content="Only verified provider options are shown; resolutions are never invented">
                      <button
                        type="button"
                        aria-label="About quality options"
                        className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                  {analysis.qualityOptions.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {analysis.qualityOptions.map((opt) => (
                        <Tooltip key={opt.id} content={opt.note}>
                          <button
                            type="button"
                            onClick={() => setSelectedQualityLabel(opt.label)}
                            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
                              selectedQualityLabel === opt.label
                                ? 'bg-[#22D3EE]/15 text-[#0E7490] dark:text-[#22D3EE] border border-[#22D3EE]/40'
                                : 'border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.08]'
                            }`}
                          >
                            {opt.label}
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                  ) : canDownload ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Original verified asset (resolution inspected via FFprobe after retrieval).
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Unavailable without verified stream authorization.
                    </p>
                  )}
                </div>
              </div>

              {/* Warnings & Unsupported Messages */}
              {(analysis.error || analysis.warnings.length > 0) && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-500/25 dark:bg-amber-500/10 space-y-2">
                  {analysis.error && (
                    <div className="flex items-start gap-2 text-xs font-medium text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                      <span>{analysis.error}</span>
                    </div>
                  )}
                  {analysis.warnings.map((warn, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 leading-relaxed"
                    >
                      <Info className="h-3.5 w-3.5 shrink-0 text-amber-500 mt-0.5" />
                      <span>{warn}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Active / Completed Worker Job Progress Panel */}
              {activeJob && (
                <div className="rounded-xl border border-[#8B5CF6]/30 bg-slate-50/90 p-4 dark:border-[#8B5CF6]/30 dark:bg-[#080B14]/85 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 text-xs">
                      <StatusIndicator status={activeJob.status} />
                      <span aria-hidden="true" className="text-slate-400">·</span>
                      <span className="font-mono text-slate-600 dark:text-slate-300">
                        {activeJob.targetFormat}
                      </span>
                      {(activeJob.retryCount ?? 0) > 0 && (
                        <>
                          <span aria-hidden="true" className="text-slate-400">·</span>
                          <span className="font-mono font-medium text-amber-600 dark:text-amber-400">
                            Retry {activeJob.retryCount}/{activeJob.maxRetries ?? 3}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs">
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {activeJob.totalBytes !== null
                          ? `${formatBytes(activeJob.bytesDownloaded)} / ${formatBytes(
                              activeJob.totalBytes
                            )}`
                          : formatBytes(activeJob.bytesDownloaded)}
                        {activeJob.progressPercent !== null
                          ? ` (${activeJob.progressPercent}%)`
                          : ''}
                      </span>
                      {isJobRunning && (
                        <button
                          type="button"
                          onClick={() => void onCancelDownload(activeJob.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20"
                        >
                          <Ban className="h-3 w-3" aria-hidden="true" />
                          <span>Cancel</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Real Progress Bar */}
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={activeJob.progressPercent ?? undefined}
                    className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10"
                  >
                    <div
                      className={`h-full transition-all duration-300 ${
                        activeJob.status === 'failed' ||
                        activeJob.status === 'permanently_failed'
                          ? 'bg-rose-500'
                          : activeJob.status === 'cancelled'
                          ? 'bg-slate-400'
                          : activeJob.status === 'completed'
                          ? 'bg-emerald-500'
                          : 'bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]'
                      }`}
                      style={{
                        width:
                          activeJob.progressPercent !== null
                            ? `${activeJob.progressPercent}%`
                            : isJobRunning
                            ? '60%'
                            : '100%',
                      }}
                    />
                  </div>

                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {activeJob.stageMessage}
                  </p>

                  {(activeJob.status === 'failed' ||
                    activeJob.status === 'permanently_failed') &&
                    activeJob.error && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/80 p-3 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
                    >
                      <AlertCircle className="h-4 w-4 shrink-0 text-rose-500 mt-0.5" />
                      <span>{activeJob.error}</span>
                    </div>
                  )}

                  {activeJob.status === 'completed' && activeJob.verifiedMetadata && (
                    <div className="space-y-3 border-t border-slate-200 dark:border-white/[0.08] pt-3">
                      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        <div>
                          <dt className="text-slate-500 dark:text-slate-400">Container &amp; MIME</dt>
                          <dd className="mt-0.5 font-mono text-slate-900 dark:text-white">
                            {activeJob.verifiedMetadata.container} ({activeJob.verifiedMetadata.mimeType})
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500 dark:text-slate-400">Verified Size</dt>
                          <dd className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-white">
                            {formatBytes(activeJob.verifiedMetadata.sizeBytes)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500 dark:text-slate-400">Resolution / Duration</dt>
                          <dd className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-white">
                            {activeJob.verifiedMetadata.resolutionLabel || 'Audio/Asset'}
                            {activeJob.verifiedMetadata.durationSeconds
                              ? ` · ${activeJob.verifiedMetadata.durationSeconds}s`
                              : ''}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500 dark:text-slate-400">Codecs</dt>
                          <dd className="mt-0.5 font-mono text-slate-900 dark:text-white">
                            {[
                              activeJob.verifiedMetadata.videoCodec,
                              activeJob.verifiedMetadata.audioCodec,
                            ]
                              .filter(Boolean)
                              .join(' / ') || 'Verified'}
                          </dd>
                        </div>
                      </dl>

                      {activeJob.downloadUrl && (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            Single-use session-bound download link
                            {activeJob.expiresAt
                              ? ` · Expires ${new Date(
                                  activeJob.expiresAt
                                ).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}`
                              : ''}
                          </span>
                          <button
                            type="button"
                            onClick={async () => {
                              const dl = await onDownloadFile(
                                activeJob.id,
                                activeJob.verifiedMetadata?.container
                              );
                              if (!dl.ok) setDownloadSubmitError(dl.error);
                            }}
                            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                          >
                            <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                            <span>Save Verified File ({activeJob.verifiedMetadata.container})</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Action Footer: Real Authorized Download vs Restricted Disclosure */}
              {canDownload ? (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4 dark:border-white/[0.08] dark:bg-[#080B14]/70">
                  <label className="flex items-start gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={userConfirmedPermission}
                      onChange={(e) => {
                        setUserConfirmedPermission(e.target.checked);
                        if (downloadSubmitError) setDownloadSubmitError(null);
                      }}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#8B5CF6] focus:ring-[#8B5CF6] dark:border-white/20 dark:bg-[#111827]"
                    />
                    <span className="leading-relaxed">
                      I confirm that I own this media asset or have explicit permission
                      from the rights holder to retrieve and process it in{' '}
                      <strong className="font-mono">{selectedFormat}</strong> format.
                    </span>
                  </label>

                  {downloadSubmitError && (
                    <p role="alert" className="text-xs font-medium text-rose-600 dark:text-rose-400">
                      {downloadSubmitError}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={() => void handleSaveQueue()}
                      className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-white/[0.1] whitespace-nowrap"
                    >
                      <BookmarkPlus className="h-3.5 w-3.5 text-[#22D3EE]" aria-hidden="true" />
                      <span>{savedNotice ? 'Recorded in History' : 'Log Analysis Only'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={!userConfirmedPermission || isStartingDownload || Boolean(isJobRunning)}
                      onClick={() => void handleStartAuthorizedDownload()}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#8B5CF6] px-5 py-2.5 text-xs font-semibold text-white shadow-sm shadow-[#8B5CF6]/25 transition-colors hover:bg-[#7C3AED] disabled:opacity-50 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]"
                    >
                      {isStartingDownload || isJobRunning ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          <span>Worker Active...</span>
                        </>
                      ) : (
                        <>
                          <Download className="h-4 w-4" aria-hidden="true" />
                          <span>Download Verified {selectedFormat}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50/80 p-4 dark:border-white/[0.08] dark:bg-[#080B14]/70">
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                    Downloading is unavailable for this source without official provider
                    authorization or direct HTTPS media permissions. You can record this
                    inspection in your history.
                  </p>

                  <div className="flex items-center gap-2 shrink-0">
                    {savedNotice ? (
                      <button
                        type="button"
                        onClick={() => onNavigate('downloads')}
                        className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 whitespace-nowrap"
                      >
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        <span>Saved — View Downloads</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void handleSaveQueue()}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/[0.12] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                      >
                        <BookmarkPlus className="h-4 w-4 text-[#22D3EE]" aria-hidden="true" />
                        <span>
                          {isSaving
                            ? 'Saving...'
                            : analysis.success
                            ? 'Save to History'
                            : 'Log Restricted / Unsupported'}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Supported Platform Indicators */}
        <div className="mx-auto mt-6 max-w-3xl">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Supported sources (select any source to test live URL intelligence)
            </span>
            <button
              type="button"
              onClick={() => onNavigate('platforms')}
              className="inline-flex items-center gap-1 text-xs font-medium text-[#7C3AED] hover:text-[#6D28D9] dark:text-[#22D3EE] dark:hover:text-[#67E8F9] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
            >
              <span>Platform capabilities</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {SUPPORTED_PLATFORMS.map((platform) => (
              <Tooltip
                key={platform.id}
                content={`Test ${platform.name} URL intelligence`}
              >
                <button
                  type="button"
                  onClick={() => handleUseExample(platform.exampleUrl)}
                  className="flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 min-h-[42px] text-left text-xs font-medium text-slate-700 transition-colors hover:border-[#8B5CF6]/40 hover:bg-slate-50 dark:border-white/[0.08] dark:bg-[#111827]/70 dark:text-slate-200 dark:hover:border-[#8B5CF6]/50 dark:hover:bg-[#111827] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                >
                  <PlatformIcon platform={platform.id} className="h-4 w-4 shrink-0" />
                  <span className="truncate">{platform.shortLabel}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </section>

      {/* Recent Downloads / Activity */}
      <section className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
              Recent Activity
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Links analyzed and authorized media jobs processed during your workspace session.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('downloads')}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded"
          >
            <span>Open Downloads</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {recentHistory.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center dark:border-white/10 dark:bg-[#111827]/40">
            <Inbox
              className="mx-auto h-8 w-8 text-slate-400 dark:text-slate-500"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100">
              No recent activity yet
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Analyze a supported HTTPS link above to inspect capabilities or download
              authorized direct media, or explore platform boundaries first.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => inputRef.current?.focus()}
                className="rounded-xl bg-[#8B5CF6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#7C3AED] transition-colors"
              >
                Focus URL Input
              </button>
              <button
                type="button"
                onClick={() => onNavigate('platforms')}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200"
              >
                Explore Supported Platforms
              </button>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-white/[0.08] rounded-2xl border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-[#111827]/75 overflow-hidden">
            {recentHistory.slice(0, 4).map((item) => (
              <div
                key={item.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3.5 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <PlatformIcon platform={item.platform} className="h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {item.platformName}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{item.mediaType}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{item.fileType}</span>
                      {item.sizeBytes ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {formatBytes(item.sizeBytes)}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {item.url}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                  <StatusIndicator status={item.status} />
                  {item.status === 'completed' && item.jobId && item.downloadUrl ? (
                    <button
                      type="button"
                      onClick={() => void onDownloadFile(item.jobId!, item.fileType)}
                      className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 whitespace-nowrap"
                    >
                      Save File
                    </button>
                  ) : null}
                  <span className="font-mono text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Feature Overview */}
      <section className="mx-auto max-w-5xl border-t border-slate-200 dark:border-white/[0.08] pt-10">
        <div className="mb-6">
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
            Secure Media Architecture
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Strict HTTPS security checks, isolated worker streaming, and FFmpeg verification.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/65">
            <Layers className="h-5 w-5 text-[#8B5CF6]" aria-hidden="true" />
            <h3 className="mt-4 font-display text-base font-semibold text-slate-900 dark:text-white">
              Isolated Media Worker
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Executes authorized direct media transfers in a memory-capped child
              process with stripped environment secrets and expiring temp files.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/65">
            <Sliders className="h-5 w-5 text-[#22D3EE]" aria-hidden="true" />
            <h3 className="mt-4 font-display text-base font-semibold text-slate-900 dark:text-white">
              FFmpeg &amp; Signature Checks
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Verifies MIME headers against binary magic bytes, runs FFprobe
              integrity inspection, and converts permitted containers safely.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/65">
            <ShieldCheck className="h-5 w-5 text-emerald-500" aria-hidden="true" />
            <h3 className="mt-4 font-display text-base font-semibold text-slate-900 dark:text-white">
              SSRF &amp; Redirect Defense
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Pins validated public IPs, rejects private IPv4/IPv6 ranges, and
              validates every redirect destination independently.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
