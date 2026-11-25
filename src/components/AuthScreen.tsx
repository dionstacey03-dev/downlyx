import React, { useState } from 'react';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Moon,
  ShieldCheck,
  Sun,
  User as UserIcon,
} from 'lucide-react';
import type { ThemeMode } from '../types/media.ts';
import { auth, googleProvider } from '../firebase.ts';
import { BrandMark } from './BrandMark.tsx';

type AuthMode = 'login' | 'register' | 'reset';

interface AuthScreenProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  sessionNotice?: string | null;
  onDismissNotice?: () => void;
}

function mapFirebaseAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email address or password. Please check your credentials and try again.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in or resetting your password.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/weak-password':
      return 'Password must be at least 8 characters and include a mix of letters and numbers.';
    case 'auth/too-many-requests':
      return 'Too many attempts detected. Please wait a moment before trying again.';
    case 'auth/popup-closed-by-user':
      return 'Google sign-in popup was closed before completing authentication.';
    case 'auth/popup-blocked':
      return 'Sign-in popup was blocked by your browser. Please allow popups for this site.';
    case 'auth/operation-not-allowed':
      return 'Email/Password sign-in is not yet enabled in Firebase Console -> Authentication -> Sign-in method.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    default:
      return err instanceof Error && err.message
        ? err.message
        : 'Authentication failed. Please try again.';
  }
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  theme,
  onToggleTheme,
  sessionNotice,
  onDismissNotice,
}) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setErrorMsg(null);
    setInfoMsg(null);
  };

  const validateFields = (): string | null => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return 'Please enter a valid email address.';
    }
    if (mode === 'reset') return null;
    if (mode === 'register') {
      if (!displayName.trim() || displayName.trim().length < 2) {
        return 'Please enter your name (at least 2 characters).';
      }
      if (password.length < 8) {
        return 'Password must be at least 8 characters long.';
      }
    } else if (!password) {
      return 'Please enter your password.';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);

    const validationError = validateFields();
    if (validationError) {
      setErrorMsg(validationError);
      return;
    }

    setIsSubmitting(true);
    try {
      const normalizedEmail = email.trim();
      if (mode === 'login') {
        await signInWithEmailAndPassword(auth, normalizedEmail, password);
      } else if (mode === 'register') {
        const cred = await createUserWithEmailAndPassword(
          auth,
          normalizedEmail,
          password
        );
        await updateProfile(cred.user, {
          displayName: displayName.trim().slice(0, 80),
        });
        await sendEmailVerification(cred.user);
      } else {
        try {
          await sendPasswordResetEmail(auth, normalizedEmail);
        } catch (resetErr) {
          const resetCode =
            typeof resetErr === 'object' && resetErr !== null && 'code' in resetErr
              ? String((resetErr as { code?: unknown }).code)
              : '';
          if (resetCode !== 'auth/user-not-found') {
            throw resetErr;
          }
        }
        setInfoMsg(
          'Password reset instructions have been sent if an account exists for that email.'
        );
      }
    } catch (err) {
      setErrorMsg(mapFirebaseAuthError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setInfoMsg(null);
    setIsGoogleLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setErrorMsg(mapFirebaseAuthError(err));
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const busy = isSubmitting || isGoogleLoading;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-[#080B14] dark:text-slate-100 transition-colors duration-200">
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white/85 px-4 sm:px-8 backdrop-blur-md dark:border-white/[0.08] dark:bg-[#080B14]/85">
        <BrandMark />
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={
            theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
          }
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-[#111827] dark:text-slate-200 dark:hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
        >
          {theme === 'dark' ? (
            <Sun className="h-4 w-4 text-amber-400" />
          ) : (
            <Moon className="h-4 w-4 text-slate-700" />
          )}
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
          {/* Left Context Panel */}
          <div className="lg:col-span-6 space-y-6">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#7C3AED] dark:text-[#22D3EE]">
                Authenticated Media Workspace
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-white leading-tight [text-wrap:balance]">
                Sign in to access your verified media downloads
              </h1>
              <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed max-w-lg">
                Your download queue, workspace preferences, and activity history are bound strictly to your verified account and enforced server-side.
              </p>
            </div>

            <div className="space-y-3 border-t border-slate-200 dark:border-white/[0.08] pt-5 text-sm text-slate-600 dark:text-slate-300">
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-[#22D3EE] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">
                    Per-Account Download Ownership
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Every worker job and single-use download ticket is bound to your verified Firebase UID.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Lock className="h-5 w-5 text-[#8B5CF6] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">
                    Isolated Execution &amp; URL Security
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    HTTPS-only inspection, pinned public DNS resolution, MIME signature checks, and FFprobe verification.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Authentication Card */}
          <div className="lg:col-span-6 w-full max-w-md mx-auto lg:max-w-none">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm dark:border-white/[0.08] dark:bg-[#111827]/85 space-y-6">
              {sessionNotice && (
                <div
                  role="alert"
                  className="flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                >
                  <span>{sessionNotice}</span>
                  {onDismissNotice && (
                    <button
                      type="button"
                      onClick={onDismissNotice}
                      className="font-semibold underline underline-offset-2 shrink-0"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              )}

              {/* Mode Switcher */}
              {mode !== 'reset' ? (
                <div
                  role="tablist"
                  aria-label="Authentication mode"
                  className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-white/10 dark:bg-[#080B14]"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'login'}
                    onClick={() => switchMode('login')}
                    className={`rounded-lg py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                      mode === 'login'
                        ? 'bg-white text-slate-900 shadow-xs dark:bg-[#8B5CF6] dark:text-white'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    }`}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'register'}
                    onClick={() => switchMode('register')}
                    className={`rounded-lg py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                      mode === 'register'
                        ? 'bg-white text-slate-900 shadow-xs dark:bg-[#8B5CF6] dark:text-white'
                        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    }`}
                  >
                    Create Account
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-white">
                    Reset Password
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Enter your account email to receive a password reset link.
                  </p>
                </div>
              )}

              {mode !== 'reset' && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleGoogleSignIn()}
                    className="flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60 dark:border-white/15 dark:bg-white/[0.04] dark:text-white dark:hover:bg-white/[0.08] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                  >
                    {isGoogleLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          fill="#4285F4"
                          d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 24c3.3 0 6.08-1.09 8.1-2.96l-3.88-3.05c-1.09.73-2.49 1.16-4.22 1.16-3.24 0-5.99-2.19-6.97-5.13H1.02v3.14C3.05 21.2 7.21 24 12 24Z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.03 14.02A7.18 7.18 0 0 1 4.65 12c0-.7.13-1.38.38-2.02V6.84H1.02A11.98 11.98 0 0 0 0 12c0 1.94.46 3.77 1.02 5.16l4.01-3.14Z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 4.85c1.8 0 3.41.62 4.68 1.84l3.5-3.5C18.07 1.19 15.3 0 12 0 7.21 0 3.05 2.8 1.02 6.84l4.01 3.14c.98-2.94 3.73-5.13 6.97-5.13Z"
                        />
                      </svg>
                    )}
                    <span>Continue with Google</span>
                  </button>

                  <div className="relative flex items-center justify-center">
                    <div className="h-px w-full bg-slate-200 dark:bg-white/[0.08]" />
                    <span className="bg-white px-3 text-xs text-slate-400 dark:bg-[#111827] dark:text-slate-500 whitespace-nowrap">
                      or continue with email
                    </span>
                    <div className="h-px w-full bg-slate-200 dark:bg-white/[0.08]" />
                  </div>
                </>
              )}

              <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
                {mode === 'register' && (
                  <div>
                    <label
                      htmlFor="auth-display-name"
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                    >
                      Full Name
                    </label>
                    <div className="relative">
                      <UserIcon
                        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                        aria-hidden="true"
                      />
                      <input
                        id="auth-display-name"
                        type="text"
                        autoComplete="name"
                        maxLength={80}
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Alex Morgan"
                        className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#8B5CF6] focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100 dark:placeholder:text-slate-500"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="auth-email"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                  >
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail
                      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                      aria-hidden="true"
                    />
                    <input
                      id="auth-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#8B5CF6] focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100 dark:placeholder:text-slate-500"
                    />
                  </div>
                </div>

                {mode !== 'reset' && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label
                        htmlFor="auth-password"
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                      >
                        Password
                      </label>
                      {mode === 'login' && (
                        <button
                          type="button"
                          onClick={() => switchMode('reset')}
                          className="text-xs font-medium text-[#7C3AED] hover:underline dark:text-[#22D3EE]"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock
                        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                        aria-hidden="true"
                      />
                      <input
                        id="auth-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete={
                          mode === 'register' ? 'new-password' : 'current-password'
                        }
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={
                          mode === 'register'
                            ? 'Minimum 8 characters'
                            : 'Enter your password'
                        }
                        className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-11 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#8B5CF6] focus:bg-white focus:outline-none dark:border-white/10 dark:bg-[#080B14] dark:text-slate-100 dark:placeholder:text-slate-500"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={
                          showPassword ? 'Hide password' : 'Show password'
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-white/10"
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {errorMsg && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
                  >
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                {infoMsg && (
                  <div
                    role="status"
                    className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{infoMsg}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#8B5CF6] px-4 text-sm font-semibold text-white hover:bg-[#7C3AED] disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]"
                >
                  {isSubmitting && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  )}
                  <span>
                    {mode === 'login'
                      ? 'Sign In'
                      : mode === 'register'
                      ? 'Create Verified Account'
                      : 'Send Password Reset Link'}
                  </span>
                </button>

                {mode === 'reset' && (
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="w-full text-center text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
                  >
                    Back to Sign In
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
