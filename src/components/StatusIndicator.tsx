import React from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  XCircle,
  Ban,
} from 'lucide-react';
import type { DownloadStatus } from '../types/media.ts';

interface StatusIndicatorProps {
  status: DownloadStatus;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status }) => {
  switch (status) {
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#22D3EE] whitespace-nowrap">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Queued</span>
        </span>
      );
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#8B5CF6] dark:text-[#A78BFA] whitespace-nowrap">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span>Streaming</span>
        </span>
      );
    case 'verifying':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#22D3EE] whitespace-nowrap">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Verifying</span>
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Completed</span>
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 whitespace-nowrap">
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Failed</span>
        </span>
      );
    case 'permanently_failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700 dark:text-rose-400 whitespace-nowrap">
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Permanently Failed</span>
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
          <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Cancelled</span>
        </span>
      );
    case 'analyzed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Analyzed</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Unsupported</span>
        </span>
      );
  }
};
