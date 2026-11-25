import React from 'react';
import {
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ShieldAlert,
} from 'lucide-react';
import { SUPPORTED_PLATFORMS } from '../utils/platformDetector.ts';
import { PlatformIcon } from '../components/PlatformIcon.tsx';
import { Tooltip } from '../components/Tooltip.tsx';

interface PlatformsPageProps {
  onTestExampleUrl: (url: string) => void;
}

export const PlatformsPage: React.FC<PlatformsPageProps> = ({
  onTestExampleUrl,
}) => {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="max-w-3xl">
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          Supported Platforms &amp; Capability Matrix
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          DOWNLYX clearly separates URL pattern detection, metadata
          availability, authorized media retrieval scope, and actual file
          downloading. Direct HTTPS media assets run in an isolated worker;
          social platforms remain restricted to official authorizations.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {SUPPORTED_PLATFORMS.map((platform) => {
          const capabilityRows = [
            platform.capabilities.urlDetection,
            platform.capabilities.metadataAvailability,
            platform.capabilities.authorizedRetrieval,
            platform.capabilities.downloadAvailability,
          ];

          return (
            <article
              key={platform.id}
              className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75"
            >
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.04]">
                      <PlatformIcon platform={platform.id} className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                        {platform.name}
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {platform.supportedTypes.join(' · ')}
                      </p>
                    </div>
                  </div>
                </div>

                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {platform.tagline}
                </p>

                {/* 4-Dimension Capability Breakdown */}
                <div className="border-t border-slate-200 dark:border-white/[0.08] pt-4">
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-200 mb-3">
                    Capability Breakdown
                  </h3>
                  <dl className="space-y-2.5 text-xs">
                    {capabilityRows.map((cap) => (
                      <div
                        key={cap.label}
                        className="flex items-start justify-between gap-3"
                      >
                        <dt className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300 shrink-0">
                          {cap.status === 'supported' ? (
                            <CheckCircle2
                              className="h-3.5 w-3.5 text-emerald-500 shrink-0"
                              aria-hidden="true"
                            />
                          ) : cap.status === 'restricted' ||
                            cap.status === 'requires_authorization' ? (
                            <ShieldAlert
                              className="h-3.5 w-3.5 text-amber-500 shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <Clock
                              className="h-3.5 w-3.5 text-slate-400 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                          <span>{cap.label}</span>
                        </dt>
                        <dd className="text-right text-slate-500 dark:text-slate-400 leading-snug">
                          {cap.state}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>

                {/* Explicit Instagram Stories Notice */}
                {platform.storyNote && (
                  <div className="flex items-start gap-2.5 border-t border-slate-200 dark:border-white/[0.08] pt-3.5 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                    <ShieldAlert
                      className="h-4 w-4 shrink-0 text-amber-500 mt-0.5"
                      aria-hidden="true"
                    />
                    <p>{platform.storyNote}</p>
                  </div>
                )}

                <dl className="space-y-2.5 border-t border-slate-200 dark:border-white/[0.08] pt-4 text-xs">
                  <div>
                    <dt className="text-slate-500 dark:text-slate-400">
                      Accepted URL Patterns
                    </dt>
                    <dd className="mt-1 font-mono text-slate-800 dark:text-slate-200 break-all">
                      {platform.patternSummary}
                    </dd>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <dt className="text-slate-500 dark:text-slate-400">
                        Target Containers
                      </dt>
                      <dd className="mt-1 font-mono text-slate-800 dark:text-slate-200">
                        {platform.formatOptions.join(' / ')}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 dark:text-slate-400">
                        Supported Quality Tiers
                      </dt>
                      <dd className="mt-1 text-slate-800 dark:text-slate-200">
                        {platform.qualityTiers.join(' · ')}
                      </dd>
                    </div>
                  </div>
                </dl>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-200 dark:border-white/[0.08] pt-4">
                <span className="truncate font-mono text-xs text-slate-400 dark:text-slate-500">
                  {platform.domains.join(', ')}
                </span>
                <Tooltip content={`Open ${platform.name} sample in URL Analyzer`}>
                  <button
                    type="button"
                    onClick={() => onTestExampleUrl(platform.exampleUrl)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-800 transition-colors hover:border-[#8B5CF6]/50 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.08] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                  >
                    <span>Try Example URL</span>
                    <ArrowUpRight
                      className="h-3.5 w-3.5 text-[#8B5CF6] dark:text-[#22D3EE]"
                      aria-hidden="true"
                    />
                  </button>
                </Tooltip>
              </div>
            </article>
          );
        })}
      </div>

      {/* Unsupported Providers Disclosure */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/65">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="h-5 w-5 shrink-0 text-amber-500 mt-0.5"
            aria-hidden="true"
          />
          <div className="space-y-1.5">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              Unsupported Sources &amp; Access Boundaries
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              DOWNLYX explicitly rejects DRM-protected streaming catalogs,
              paywalled media, private Instagram Stories or login-gated social
              posts, and unrecognized third-party domains. Localhost and private
              network addresses are also blocked during URL validation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
