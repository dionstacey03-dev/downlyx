import React, { useEffect, useRef } from 'react';
import {
  Home,
  Download,
  Layers,
  Settings,
  HelpCircle,
  Sun,
  Moon,
  X,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import type { NavPage, ThemeMode } from '../types/media.ts';
import { BrandMark } from './BrandMark.tsx';
import { Tooltip } from './Tooltip.tsx';

export interface SidebarUserSummary {
  displayName: string;
  email: string;
  photoURL: string;
  emailVerified: boolean;
}

interface SidebarProps {
  activePage: NavPage;
  onNavigate: (page: NavPage) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  user: SidebarUserSummary;
  onSignOut: () => void;
  historyCount: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: {
  id: NavPage;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'home', label: 'Home Dashboard', icon: Home },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'platforms', label: 'Supported Platforms', icon: Layers },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'help', label: 'Help & About', icon: HelpCircle },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activePage,
  onNavigate,
  theme,
  onToggleTheme,
  user,
  onSignOut,
  historyCount,
  mobileOpen,
  onCloseMobile,
}) => {
  const navRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    closeButtonRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [mobileOpen, onCloseMobile]);

  const handleNavKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowDown') {
      nextIndex = (index + 1) % NAV_ITEMS.length;
    } else if (e.key === 'ArrowUp') {
      nextIndex = (index - 1 + NAV_ITEMS.length) % NAV_ITEMS.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = NAV_ITEMS.length - 1;
    }

    if (nextIndex !== null) {
      e.preventDefault();
      navRefs.current[nextIndex]?.focus();
    }
  };

  const initials = (user.displayName || user.email || 'U')
    .trim()
    .slice(0, 2)
    .toUpperCase();

  const renderNavContent = (isMobileDrawer: boolean) => (
    <div className="flex h-full flex-col justify-between bg-white dark:bg-[#0B0F1C] border-r border-slate-200 dark:border-white/[0.08] px-4 py-5">
      <div>
        <div className="flex items-center justify-between px-2 pb-6">
          <button
            type="button"
            onClick={() => {
              onNavigate('home');
              onCloseMobile();
            }}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded-lg"
          >
            <BrandMark />
          </button>
          {isMobileDrawer && (
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onCloseMobile}
              aria-label="Close navigation menu"
              className="lg:hidden flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <nav aria-label="Primary Navigation" className="space-y-1">
          {NAV_ITEMS.map((item, index) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                ref={(el) => {
                  if (!isMobileDrawer) {
                    navRefs.current[index] = el;
                  }
                }}
                type="button"
                onClick={() => {
                  onNavigate(item.id);
                  onCloseMobile();
                }}
                onKeyDown={
                  !isMobileDrawer ? (e) => handleNavKeyDown(e, index) : undefined
                }
                aria-current={isActive ? 'page' : undefined}
                className={`group flex w-full items-center justify-between rounded-xl px-3 py-2.5 min-h-[42px] text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] whitespace-nowrap ${
                  isActive
                    ? 'bg-[#8B5CF6]/12 text-[#7C3AED] dark:bg-[#8B5CF6]/15 dark:text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.04] dark:hover:text-slate-200'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon
                    className={`h-4 w-4 shrink-0 transition-colors ${
                      isActive
                        ? 'text-[#8B5CF6] dark:text-[#22D3EE]'
                        : 'text-slate-400 group-hover:text-slate-700 dark:text-slate-500 dark:group-hover:text-slate-300'
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'downloads' && historyCount > 0 && (
                  <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {historyCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="space-y-3 border-t border-slate-200 dark:border-white/[0.08] pt-4">
        <Tooltip
          className="w-full"
          content={
            theme === 'dark'
              ? 'Switch to Crisp Light theme'
              : 'Switch to Midnight Dark theme'
          }
        >
          <button
            type="button"
            onClick={onToggleTheme}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 min-h-[42px] text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.04] dark:hover:text-slate-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
          >
            <span className="flex items-center gap-3 whitespace-nowrap">
              {theme === 'dark' ? (
                <Moon className="h-4 w-4 text-[#22D3EE]" aria-hidden="true" />
              ) : (
                <Sun className="h-4 w-4 text-amber-500" aria-hidden="true" />
              )}
              <span>{theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</span>
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500">
              Switch
            </span>
          </button>
        </Tooltip>

        <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <button
            type="button"
            onClick={() => {
              onNavigate('settings');
              onCloseMobile();
            }}
            className="flex items-center gap-2.5 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] rounded-lg"
          >
            {user.photoURL ? (
              <img
                src={user.photoURL}
                alt={user.displayName}
                referrerPolicy="no-referrer"
                className="h-8 w-8 rounded-full object-cover shrink-0 border border-slate-200 dark:border-white/10"
              />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#8B5CF6]/15 text-xs font-semibold text-[#7C3AED] dark:text-[#22D3EE] shrink-0">
                {initials}
              </span>
            )}
            <div className="min-w-0">
              <p className="flex items-center gap-1 text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                <span className="truncate">{user.displayName}</span>
                {user.emailVerified && (
                  <ShieldCheck
                    className="h-3.5 w-3.5 text-emerald-500 shrink-0"
                    aria-label="Verified account"
                  />
                )}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {user.email}
              </p>
            </div>
          </button>

          <Tooltip content="Sign out">
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white transition-colors"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block lg:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen">
        {renderNavContent(false)}
      </aside>

      {mobileOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mobile navigation"
          className="fixed inset-0 z-50 lg:hidden flex"
        >
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-10 w-72 max-w-[85vw] h-full">
            {renderNavContent(true)}
          </div>
        </div>
      )}
    </>
  );
};
