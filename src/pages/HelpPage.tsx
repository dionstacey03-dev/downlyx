import React from 'react';
import { BookOpen, ShieldAlert, Layers, ArrowRight } from 'lucide-react';
import type { NavPage } from '../types/media.ts';

interface HelpPageProps {
  onNavigate: (page: NavPage) => void;
}

export const HelpPage: React.FC<HelpPageProps> = ({ onNavigate }) => {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          Help &amp; About DOWNLYX
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Usage guide, supported platform boundaries, and responsible media
          handling guidelines.
        </p>
      </div>

      {/* User Instructions */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75 space-y-5">
        <div className="flex items-center gap-2.5">
          <BookOpen className="h-5 w-5 text-[#22D3EE]" aria-hidden="true" />
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            How to Use DOWNLYX (Phase 1)
          </h2>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-5 border-t border-slate-200 dark:border-white/[0.08] pt-5">
          <li className="space-y-2">
            <p className="font-mono text-xs font-medium text-[#8B5CF6]">01. Copy Link</p>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Copy a public media URL
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Copy a share link from YouTube, Instagram, TikTok, Facebook, X /
              Twitter, or a direct public media file URL.
            </p>
          </li>

          <li className="space-y-2">
            <p className="font-mono text-xs font-medium text-[#22D3EE]">02. Analyze</p>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Validate &amp; inspect source
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Paste the URL on the Home Dashboard and select Analyze to verify
              domain support, resource ID, and available containers.
            </p>
          </li>

          <li className="space-y-2">
            <p className="font-mono text-xs font-medium text-emerald-500">03. Stage Queue</p>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Save target presets
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Choose your preferred container and resolution preset, then save
              the entry to your Downloads queue for Phase 2 retrieval.
            </p>
          </li>
        </ol>
      </section>

      {/* Platform Support Scope */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Layers className="h-5 w-5 text-[#8B5CF6]" aria-hidden="true" />
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
              Platform Support &amp; Phase Roadmap
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('platforms')}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#7C3AED] dark:text-[#22D3EE] whitespace-nowrap"
          >
            <span>View Platforms</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          <p>
            In <strong className="font-medium text-slate-900 dark:text-white">Phase 1</strong>,
            DOWNLYX provides the complete frontend workspace, strict client and
            server URL validation, platform pattern recognition, user
            preferences, and queue tracking. Media binary downloading is
            deliberately omitted until Phase 2 backend worker infrastructure is
            connected.
          </p>
          <p>
            Only links matching the six supported sources (YouTube, Instagram,
            TikTok, Facebook, X / Twitter, and Direct Media URLs) are accepted.
            Unsupported domains, local network addresses, and non-HTTP schemes
            are flagged transparently.
          </p>
        </div>
      </section>

      {/* Copyright & Permissions Guidance */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75 space-y-4">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="h-5 w-5 text-amber-500" aria-hidden="true" />
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            Copyright &amp; Permissions Guidance
          </h2>
        </div>

        <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400 leading-relaxed list-disc pl-5">
          <li>
            Only manage, archive, or download media that you personally own,
            created, or have explicit written permission from the rights holder
            to save offline.
          </li>
          <li>
            Respect Creative Commons licenses, attribution requirements, and
            each platform&apos;s Terms of Service.
          </li>
          <li>
            Do not attempt to bypass DRM protections, paywalls, private
            account restrictions, or access controls.
          </li>
        </ul>
      </section>
    </div>
  );
};
