import React from 'react';

interface BrandMarkProps {
  compact?: boolean;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ compact = false }) => {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#8B5CF6] to-[#22D3EE] shadow-sm shadow-[#8B5CF6]/20"
        aria-hidden="true"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 4V15M12 15L7.5 10.5M12 15L16.5 10.5"
            stroke="#FFFFFF"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5 18.5H19"
            stroke="#FFFFFF"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
      {!compact && (
        <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0">
          DOWNLYX
        </span>
      )}
    </div>
  );
};
