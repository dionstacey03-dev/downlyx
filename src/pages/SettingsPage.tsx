import React, { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Sun,
  Moon,
  CheckCircle2,
  User as UserIcon,
  Sliders,
  LogOut,
  Trash2,
  ShieldCheck,
  AlertTriangle,
  MailCheck,
  Loader2,
} from 'lucide-react';
import type {
  FormatPreference,
  QualityPreference,
  ThemeMode,
  UserPreferences,
} from '../types/media.ts';
import { QUALITY_PREFERENCE_LABELS } from '../utils/platformDetector.ts';

interface SettingsPageProps {
  theme: ThemeMode;
  onSetTheme: (theme: ThemeMode) => void;
  preferences: UserPreferences;
  onSavePreferences: (prefs: UserPreferences) => Promise<boolean>;
  firebaseUser: User;
  onUpdateDisplayName: (name: string) => Promise<{ ok: boolean; error?: string }>;
  onResendVerification: () => Promise<{ ok: boolean; message: string }>;
  onRefreshVerification: () => Promise<boolean>;
  onSignOut: () => Promise<void>;
  onDeleteAccount: (password?: string) => Promise<{ ok: boolean; error?: string }>;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  theme,
  onSetTheme,
  preferences,
  onSavePreferences,
  firebaseUser,
  onUpdateDisplayName,
  onResendVerification,
  onRefreshVerification,
  onSignOut,
  onDeleteAccount,
}) => {
  const [draft, setDraft] = useState<UserPreferences>(preferences);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const [displayNameDraft, setDisplayNameDraft] = useState(
    firebaseUser.displayName || ''
  );
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [verificationFeedback, setVerificationFeedback] = useState<string | null>(
    null
  );

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const hasPasswordProvider = firebaseUser.providerData.some(
    (p) => p.providerId === 'password'
  );
  const providerLabels = firebaseUser.providerData
    .map((p) =>
      p.providerId === 'google.com'
        ? 'Google'
        : p.providerId === 'password'
        ? 'Email & Password'
        : p.providerId
    )
    .join(', ');

  useEffect(() => {
    setDraft(preferences);
  }, [preferences]);

  useEffect(() => {
    setDisplayNameDraft(firebaseUser.displayName || '');
  }, [firebaseUser.displayName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSavedSuccess(false);
    const ok = await onSavePreferences(draft);
    setIsSaving(false);
    if (ok) {
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2500);
    }
  };

  const handleProfileSave = async () => {
    const trimmed = displayNameDraft.trim();
    if (!trimmed) {
      setProfileFeedback({ type: 'error', text: 'Display name cannot be empty.' });
      return;
    }
    setProfileSaving(true);
    setProfileFeedback(null);
    const res = await onUpdateDisplayName(trimmed);
    setProfileSaving(false);
    if (res.ok) {
      setProfileFeedback({ type: 'success', text: 'Profile updated.' });
    } else {
      setProfileFeedback({
        type: 'error',
        text: res.error || 'Failed to update profile.',
      });
    }
  };

  const handleConfirmDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleteError(null);
    if (deletePhrase.trim() !== 'DELETE') {
      setDeleteError('Please type DELETE in uppercase to confirm account removal.');
      return;
    }
    if (hasPasswordProvider && !deletePassword) {
      setDeleteError('Please enter your current password to confirm account deletion.');
      return;
    }
    setDeleteLoading(true);
    const res = await onDeleteAccount(
      hasPasswordProvider ? deletePassword : undefined
    );
    setDeleteLoading(false);
    if (!res.ok) {
      setDeleteError(res.error || 'Unable to delete account.');
    }
  };

  const initials = (firebaseUser.displayName || firebaseUser.email || 'U')
    .trim()
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          Settings &amp; Account
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Manage your appearance theme, synced download preferences, profile details, and account security.
        </p>
      </div>

      {/* Authenticated Account Profile */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            {firebaseUser.photoURL ? (
              <img
                src={firebaseUser.photoURL}
                alt={firebaseUser.displayName || 'Account avatar'}
                referrerPolicy="no-referrer"
                className="h-12 w-12 rounded-xl object-cover border border-slate-200 dark:border-white/10 shrink-0"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-sm font-semibold text-[#7C3AED] dark:border-white/10 dark:bg-white/[0.04] dark:text-[#22D3EE] shrink-0">
                {initials}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white truncate">
                  {firebaseUser.displayName || 'DOWNLYX Member'}
                </h2>
                {firebaseUser.emailVerified ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Verified</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400 shrink-0">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Unverified</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {firebaseUser.email} · {providerLabels || 'Firebase Auth'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void onSignOut()}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.1] whitespace-nowrap shrink-0 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Sign Out</span>
          </button>
        </div>

        {!firebaseUser.emailVerified && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/25 dark:bg-amber-500/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-amber-800 dark:text-amber-200 space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <MailCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Verify your email address</span>
              </p>
              <p>
                Cloud download history sync and media processing require a verified email address.
              </p>
              {verificationFeedback && (
                <p className="font-medium text-emerald-700 dark:text-emerald-300">
                  {verificationFeedback}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={async () => {
                  const res = await onResendVerification();
                  setVerificationFeedback(res.message);
                }}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 whitespace-nowrap"
              >
                Resend Email
              </button>
              <button
                type="button"
                onClick={() => void onRefreshVerification()}
                className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-[#080B14] dark:text-amber-200 whitespace-nowrap"
              >
                Check Status
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-slate-200 dark:border-white/[0.08] pt-5">
          <div>
            <label
              htmlFor="account-display-name"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2"
            >
              Display Name
            </label>
            <div className="flex items-center gap-2">
              <input
                id="account-display-name"
                type="text"
                maxLength={80}
                value={displayNameDraft}
                onChange={(e) => setDisplayNameDraft(e.target.value)}
                className="h-11 flex-1 min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 focus:border-[#8B5CF6] focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100"
              />
              <button
                type="button"
                disabled={profileSaving}
                onClick={() => void handleProfileSave()}
                className="h-11 rounded-xl border border-slate-200 bg-slate-50 px-4 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.1] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
              >
                {profileSaving ? 'Saving...' : 'Update'}
              </button>
            </div>
            {profileFeedback && (
              <p
                className={`mt-1.5 text-xs ${
                  profileFeedback.type === 'success'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {profileFeedback.text}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="workspace-name"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2"
            >
              Workspace Label
            </label>
            <div className="flex items-center gap-2">
              <input
                id="workspace-name"
                type="text"
                maxLength={60}
                value={draft.workspaceName}
                onChange={(e) =>
                  setDraft({ ...draft, workspaceName: e.target.value })
                }
                className="h-11 flex-1 min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 focus:border-[#8B5CF6] focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100"
              />
              <button
                type="button"
                disabled={isSaving}
                onClick={() => void onSavePreferences(draft)}
                className="h-11 rounded-xl border border-slate-200 bg-slate-50 px-4 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.1] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
              >
                Save Label
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Theme Settings */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75 space-y-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            Appearance &amp; Theme
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Synchronized with the header and sidebar theme toggle and persisted in browser storage.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Theme selection"
          className="grid grid-cols-1 sm:grid-cols-2 gap-4"
        >
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'dark'}
            onClick={() => onSetTheme('dark')}
            className={`flex items-center justify-between rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
              theme === 'dark'
                ? 'border-[#8B5CF6] bg-[#8B5CF6]/10'
                : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#080B14] border border-white/10 text-[#22D3EE]">
                <Moon className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  Midnight Dark
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Deep navy surfaces with #080B14 canvas
                </p>
              </div>
            </div>
            {theme === 'dark' && (
              <CheckCircle2 className="h-5 w-5 text-[#8B5CF6] shrink-0" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={theme === 'light'}
            onClick={() => onSetTheme('light')}
            className={`flex items-center justify-between rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] ${
              theme === 'light'
                ? 'border-[#8B5CF6] bg-[#8B5CF6]/10'
                : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white border border-slate-200 text-amber-500">
                <Sun className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  Crisp Light
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  High-contrast daylight workspace
                </p>
              </div>
            </div>
            {theme === 'light' && (
              <CheckCircle2 className="h-5 w-5 text-[#8B5CF6] shrink-0" aria-hidden="true" />
            )}
          </button>
        </div>
      </section>

      {/* Download Preferences */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-white/[0.08] dark:bg-[#111827]/75 space-y-6"
      >
        <div className="flex items-center gap-2.5">
          <Sliders className="h-5 w-5 text-[#22D3EE]" aria-hidden="true" />
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
              Download Preferences
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Synced to your Firestore user profile and applied to new URL analyses.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label
              htmlFor="pref-quality"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2"
            >
              Default Video Quality
            </label>
            <select
              id="pref-quality"
              value={draft.defaultQuality}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultQuality: e.target.value as QualityPreference,
                })
              }
              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 focus:border-[#8B5CF6] focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100"
            >
              <option value="best">{QUALITY_PREFERENCE_LABELS.best} (Recommended)</option>
              <option value="standard">{QUALITY_PREFERENCE_LABELS.standard}</option>
              <option value="audio">{QUALITY_PREFERENCE_LABELS.audio}</option>
            </select>
            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              Defaults to Best Available and adapts to what each provider actually offers.
            </p>
          </div>

          <div>
            <label
              htmlFor="pref-format"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2"
            >
              Default Container Format
            </label>
            <select
              id="pref-format"
              value={draft.defaultFormat}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultFormat: e.target.value as FormatPreference,
                })
              }
              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 focus:border-[#8B5CF6] focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100"
            >
              <option value="mp4">MP4 (H.264 / AAC)</option>
              <option value="webm">WebM (VP9 / Opus)</option>
              <option value="m4a">M4A (Audio)</option>
              <option value="mp3">MP3 (Audio)</option>
            </select>
          </div>
        </div>

        <div className="space-y-4 border-t border-slate-200 dark:border-white/[0.08] pt-5">
          <label className="flex items-start justify-between gap-4 cursor-pointer">
            <div>
              <span className="block text-sm font-medium text-slate-900 dark:text-white">
                Auto-detect clipboard URL on focus
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Automatically fills an HTTP/HTTPS link from your clipboard when focusing an empty URL bar.
              </span>
            </div>
            <input
              type="checkbox"
              checked={draft.autoDetectClipboard}
              onChange={(e) =>
                setDraft({ ...draft, autoDetectClipboard: e.target.checked })
              }
              className="mt-1 h-4 w-4 rounded accent-[#8B5CF6]"
            />
          </label>

          <label className="flex items-start justify-between gap-4 cursor-pointer">
            <div>
              <span className="block text-sm font-medium text-slate-900 dark:text-white">
                Cache queue history locally on this device
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Keeps a local offline cache alongside your Firestore account history.
              </span>
            </div>
            <input
              type="checkbox"
              checked={draft.saveHistoryLocally}
              onChange={(e) =>
                setDraft({ ...draft, saveHistoryLocally: e.target.checked })
              }
              className="mt-1 h-4 w-4 rounded accent-[#8B5CF6]"
            />
          </label>

          <label
            htmlFor="pref-auto-retry"
            className="flex items-start justify-between gap-4 cursor-pointer"
          >
            <div>
              <span className="block text-sm font-medium text-slate-900 dark:text-white">
                Auto-Retry failed downloads
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Automatically re-processes failed download jobs up to 3 times before marking them as permanently failed.
              </span>
            </div>
            <input
              id="pref-auto-retry"
              type="checkbox"
              checked={draft.autoRetry}
              onChange={(e) =>
                setDraft({ ...draft, autoRetry: e.target.checked })
              }
              className="mt-1 h-4 w-4 rounded accent-[#8B5CF6]"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 dark:border-white/[0.08] pt-5">
          <div aria-live="polite">
            {savedSuccess ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <span>Preferences synced to account</span>
              </span>
            ) : (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Preferences persist in Firestore for your authenticated account.
              </span>
            )}
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="rounded-xl bg-[#8B5CF6] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#7C3AED] disabled:opacity-60 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]"
          >
            {isSaving ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>
      </form>

      {/* Account Deletion Zone */}
      <section className="rounded-2xl border border-rose-200 bg-white p-6 dark:border-rose-500/25 dark:bg-[#111827]/75 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-500 shrink-0">
              <UserIcon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                Delete Account
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Permanently cancels active worker jobs, deletes your Firestore profile, download history, activity logs, and Firebase Auth account.
              </p>
            </div>
          </div>

          {!showDeleteConfirm && (
            <button
              type="button"
              onClick={() => {
                setShowDeleteConfirm(true);
                setDeleteError(null);
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-500/35 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20 whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Delete Account</span>
            </button>
          )}
        </div>

        {showDeleteConfirm && (
          <form
            onSubmit={(e) => void handleConfirmDelete(e)}
            className="border-t border-rose-200 dark:border-rose-500/20 pt-4 space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="delete-confirm-phrase"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  Type <span className="font-mono font-bold">DELETE</span> to confirm
                </label>
                <input
                  id="delete-confirm-phrase"
                  type="text"
                  value={deletePhrase}
                  onChange={(e) => setDeletePhrase(e.target.value)}
                  placeholder="DELETE"
                  className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 focus:border-rose-500 focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100"
                />
              </div>

              {hasPasswordProvider && (
                <div>
                  <label
                    htmlFor="delete-confirm-password"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                  >
                    Current Password
                  </label>
                  <input
                    id="delete-confirm-password"
                    type="password"
                    autoComplete="current-password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    placeholder="Enter password to re-authenticate"
                    className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 focus:border-rose-500 focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100"
                  />
                </div>
              )}
            </div>

            {deleteError && (
              <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                {deleteError}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={deleteLoading}
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeletePhrase('');
                  setDeletePassword('');
                  setDeleteError(null);
                }}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={deleteLoading}
                className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {deleteLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                )}
                <span>Permanently Delete Account</span>
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
};
