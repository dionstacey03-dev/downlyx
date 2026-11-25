import React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingStateProps {
  label?: string;
  rows?: number;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  label = 'Loading...',
  rows = 3,
}) => {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-4"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
        <Loader2
          className="h-4 w-4 animate-spin text-[#8B5CF6] dark:text-[#22D3EE]"
          aria-hidden="true"
        />
        <span>{label}</span>
      </div>

      <div className="space-y-2.5" aria-hidden="true">
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            className="h-10 w-full rounded-xl bg-slate-100 dark:bg-white/[0.05] animate-pulse"
          />
        ))}
      </div>
    </div>
  );
};
