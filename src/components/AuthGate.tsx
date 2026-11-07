import React, { useState, useEffect, createContext, useContext } from 'react';
import {
  Lock,
  Mail,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Eye,
  EyeOff,
  ArrowLeft
} from 'lucide-react';
import { auth } from '../firebase/config';
import {
  loginWithEmail,
  loginWithGoogle,
  handleGoogleRedirectResult,
  logoutSession,
  requestPasswordReset,
  fetchOrBootstrapProfile,
  subscribeToUserProfile,
  translateFirebaseAuthError,
  onAuthStateChanged,
  type UserProfile
} from '../firebase/authService';
import { UserAdminModal } from './UserAdminModal';
import { GalponLogoIcon } from './GalponLogoIcon';

interface AuthContextValue {
  profile: UserProfile | null;
  openUserAdminModal: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  profile: null,
  openUserAdminModal: () => {},
  logout: async () => {}
});

export function useAuthProfile(): AuthContextValue {
  return useContext(AuthContext);
}

interface AuthGateProps {
  children: React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const [initializing, setInitializing] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Login Form State
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [resetSuccessMsg, setResetSuccessMsg] = useState<string | null>(null);

  // User Admin Modal State (Only for Administrador)
  const [isUserAdminOpen, setIsUserAdminOpen] = useState(false);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    handleGoogleRedirectResult().catch((err) => {
      setAuthError(translateFirebaseAuthError(err));
    });

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }

      if (!firebaseUser) {
        setProfile(null);
        setInitializing(false);
        return;
      }

      try {
        const verifiedProfile = await fetchOrBootstrapProfile(firebaseUser);
        setProfile(verifiedProfile);
        setAuthError(null);

        unsubscribeProfile = subscribeToUserProfile(
          firebaseUser.uid,
          async (liveProfile) => {
            if (!liveProfile) {
              setAuthError('Su perfil de usuario ya no se encuentra registrado en el sistema.');
              await logoutSession();
              setProfile(null);
              return;
            }
            if (!liveProfile.active) {
              setAuthError('Su cuenta ha sido desactivada por el Administrador. Sesión finalizada.');
              await logoutSession();
              setProfile(null);
              return;
            }
            setProfile(liveProfile);
          }
        );
      } catch (err: any) {
        setProfile(null);
        setAuthError(translateFirebaseAuthError(err));
      } finally {
        setInitializing(false);
      }
    });

    const handleE2EPreview = (event: Event) => {
      if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
        const customEvent = event as CustomEvent<UserProfile | null>;
        setProfile(customEvent.detail);
        setInitializing(false);
      }
    };
    window.addEventListener('calera-e2e-preview', handleE2EPreview);

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
      window.removeEventListener('calera-e2e-preview', handleE2EPreview);
    };
  }, []);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setResetSuccessMsg(null);

    if (!email.trim() || !password) {
      setAuthError('Ingrese su correo electrónico y contraseña.');
      return;
    }

    setSubmitting(true);
    try {
      const { profile: loggedProfile } = await loginWithEmail(email, password);
      setProfile(loggedProfile);
      setPassword('');
    } catch (err: any) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setAuthError(null);
    setResetSuccessMsg(null);
    setGoogleSubmitting(true);
    try {
      const res = await loginWithGoogle();
      if (res && res.profile) {
        setProfile(res.profile);
      }
    } catch (err: any) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setGoogleSubmitting(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setResetSuccessMsg(null);

    if (!email.trim()) {
      setAuthError('Ingrese el correo electrónico asociado a su cuenta.');
      return;
    }

    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setResetSuccessMsg(
        `Se ha enviado un enlace de recuperación a ${email.trim().toLowerCase()}.`
      );
    } catch (err: any) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setIsUserAdminOpen(false);
    await logoutSession();
    setProfile(null);
  };

  if (initializing) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100">
        <GalponLogoIcon variant="login" size="lg" className="mb-4" />
        <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
          <span>Cargando Control Galpones La Calera...</span>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div
        data-testid="login-screen"
        className="min-h-screen bg-slate-950 flex flex-col justify-center items-center p-4"
      >
        <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
          {/* Cabecera Minimalista */}
          <div className="px-6 pt-6 pb-4 text-center">
            <div className="flex justify-center mb-3">
              <GalponLogoIcon variant="login" size="lg" />
            </div>
            <h1 className="text-lg font-bold text-white tracking-tight">
              Control Galpones La Calera
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Inicia sesión para continuar
            </p>
          </div>

          <div className="px-6 pb-6 pt-2">
            {authError && (
              <div className="mb-4 p-3 rounded-xl bg-red-950/60 border border-red-800/80 flex items-start gap-2 text-xs text-red-200">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div className="leading-relaxed">{authError}</div>
              </div>
            )}

            {resetSuccessMsg && (
              <div className="mb-4 p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/80 flex items-start gap-2 text-xs text-emerald-200">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div className="leading-relaxed">{resetSuccessMsg}</div>
              </div>
            )}

            {mode === 'login' ? (
              <div className="space-y-3.5">
                <form onSubmit={handleLoginSubmit} className="space-y-3.5">
                  <div>
                    <label
                      htmlFor="login-email"
                      className="block text-xs font-medium text-slate-300 mb-1"
                    >
                      Correo electrónico
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        id="login-email"
                        type="email"
                        required
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="usuario@lacalera.pe"
                        className="w-full pl-9 pr-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label
                        htmlFor="login-password"
                        className="block text-xs font-medium text-slate-300"
                      >
                        Contraseña
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setMode('reset');
                          setAuthError(null);
                          setResetSuccessMsg(null);
                        }}
                        className="text-xs text-emerald-400 hover:text-emerald-300 font-medium transition cursor-pointer"
                      >
                        Recuperar contraseña
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-9 pr-9 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 cursor-pointer"
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting || googleSubmitting}
                    className="w-full py-2.5 px-4 bg-[#0f6b38] hover:bg-emerald-600 disabled:bg-emerald-900/60 text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Iniciando sesión...</span>
                      </>
                    ) : (
                      <span>Iniciar sesión</span>
                    )}
                  </button>
                </form>

                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={submitting || googleSubmitting}
                  className="w-full py-2.5 px-4 bg-white hover:bg-slate-100 disabled:bg-slate-300 text-slate-900 font-semibold text-sm rounded-xl flex items-center justify-center gap-2.5 transition cursor-pointer border border-slate-200"
                >
                  {googleSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-slate-700" />
                      <span>Conectando con Google...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          fill="#4285F4"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                      <span>Continuar con Google</span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              <form onSubmit={handleResetSubmit} className="space-y-3.5">
                <div>
                  <label
                    htmlFor="reset-email"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Correo electrónico
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="reset-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="usuario@lacalera.pe"
                      className="w-full pl-9 pr-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-2.5 px-4 bg-[#0f6b38] hover:bg-emerald-600 disabled:bg-emerald-900/60 text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Enviando...</span>
                    </>
                  ) : (
                    <span>Recuperar contraseña</span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setAuthError(null);
                    setResetSuccessMsg(null);
                  }}
                  className="w-full py-2 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Volver a iniciar sesión</span>
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        profile,
        openUserAdminModal: () => setIsUserAdminOpen(true),
        logout: handleLogout
      }}
    >
      <div className="min-h-screen flex flex-col bg-slate-100">
        {/* Contenido Principal de la Aplicación (la identificación de usuario y controles de sesión están integrados en la barra superior verde institucional) */}
        <div className="flex-1 flex flex-col">{children}</div>

        {/* Modal de Administración de Usuarios (Exclusivo Administrador) */}
        {profile.role === 'Administrador' && isUserAdminOpen && (
          <UserAdminModal
            currentUserProfile={profile}
            onClose={() => setIsUserAdminOpen(false)}
          />
        )}
      </div>
    </AuthContext.Provider>
  );
};
