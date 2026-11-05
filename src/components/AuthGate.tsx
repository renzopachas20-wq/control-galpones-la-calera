import React, { useState, useEffect, createContext, useContext } from 'react';
import {
  Building2,
  Lock,
  Mail,
  KeyRound,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  LogOut,
  Users,
  Eye,
  EyeOff,
  ArrowLeft
} from 'lucide-react';
import {
  auth,
  firebaseConfig
} from '../firebase/config';
import {
  loginWithEmail,
  loginWithGoogle,
  logoutSession,
  requestPasswordReset,
  fetchOrBootstrapProfile,
  subscribeToUserProfile,
  translateFirebaseAuthError,
  onAuthStateChanged,
  type UserProfile
} from '../firebase/authService';
import { UserAdminModal } from './UserAdminModal';

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

        // Escuchar en tiempo real si el usuario es desactivado o cambia su rol/alcance
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

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
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
      const { profile: loggedProfile } = await loginWithGoogle();
      setProfile(loggedProfile);
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
        `Se ha enviado un enlace de recuperación a ${email.trim().toLowerCase()}. Revise su bandeja de entrada y carpeta de spam.`
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
        <div className="w-16 h-16 rounded-2xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center mb-4 animate-pulse">
          <Building2 className="w-8 h-8 text-emerald-400" />
        </div>
        <div className="flex items-center gap-2.5 text-sm font-semibold text-slate-300">
          <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
          <span>Verificando credenciales y permisos en Control Galpones La Calera...</span>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col justify-center items-center p-4 sm:p-6 relative overflow-hidden">
        {/* Fondo arquitectónico sutil */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(16,185,129,0.12),_transparent_50%),radial-gradient(circle_at_bottom_left,_rgba(30,58,138,0.18),_transparent_55%)] pointer-events-none" />

        <div className="w-full max-w-md bg-slate-900/95 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden relative z-10 backdrop-blur-md">
          {/* Cabecera Institucional */}
          <div className="px-6 pt-7 pb-5 bg-gradient-to-b from-slate-800/80 to-slate-900 border-b border-slate-800 text-center">
            <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center shadow-inner">
              <Building2 className="w-7 h-7 text-emerald-400" />
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">
              Control Galpones La Calera
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Sistema Centralizado de Gestión Constructiva, Avances y Almacén
            </p>
            <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800/90 border border-slate-700 text-[11px] font-medium text-emerald-400">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Acceso Seguro Autorizado ({firebaseConfig.projectId})</span>
            </div>
          </div>

          <div className="p-6">
            {authError && (
              <div className="mb-5 p-3.5 rounded-xl bg-red-950/60 border border-red-800/80 flex items-start gap-2.5 text-xs text-red-200">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div className="leading-relaxed">{authError}</div>
              </div>
            )}

            {resetSuccessMsg && (
              <div className="mb-5 p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-800/80 flex items-start gap-2.5 text-xs text-emerald-200">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <div className="leading-relaxed">{resetSuccessMsg}</div>
              </div>
            )}

            {mode === 'login' ? (
              <div className="space-y-4">
                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      Correo Electrónico Corporativo
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="email"
                        required
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="usuario@lacalera.pe"
                        className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-semibold text-slate-300">
                        Contraseña
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setMode('reset');
                          setAuthError(null);
                          setResetSuccessMsg(null);
                        }}
                        className="text-xs text-emerald-400 hover:text-emerald-300 font-medium transition"
                      >
                        ¿Olvidó su contraseña?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-10 pr-10 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting || googleSubmitting}
                    className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800/60 text-white font-semibold text-sm rounded-xl shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Ingresando al sistema...</span>
                      </>
                    ) : (
                      <>
                        <KeyRound className="w-4 h-4" />
                        <span>Iniciar Sesión</span>
                      </>
                    )}
                  </button>
                </form>

                {/* Separador OAuth */}
                <div className="relative flex py-1 items-center">
                  <div className="flex-grow border-t border-slate-800"></div>
                  <span className="flex-shrink mx-3 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                    o ingresar con cuenta autorizada
                  </span>
                  <div className="flex-grow border-t border-slate-800"></div>
                </div>

                {/* Botón Oficial: Continuar con Google */}
                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={submitting || googleSubmitting}
                  className="w-full py-2.5 px-4 bg-white hover:bg-slate-100 disabled:bg-slate-300 text-slate-900 font-semibold text-sm rounded-xl shadow flex items-center justify-center gap-2.5 transition cursor-pointer border border-slate-200"
                >
                  {googleSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-slate-700" />
                      <span>Verificando cuenta de Google...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" viewBox="0 0 24 24">
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
              <form onSubmit={handleResetSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Correo Electrónico a Recuperar
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="usuario@lacalera.pe"
                      className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1.5">
                    Se enviará un enlace seguro de Firebase Authentication para restablecer su contraseña.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800/60 text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Enviando enlace...</span>
                    </>
                  ) : (
                    <span>Enviar Enlace de Recuperación</span>
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
                  <span>Volver al Inicio de Sesión</span>
                </button>
              </form>
            )}

            <div className="mt-6 pt-4 border-t border-slate-800/80 text-center">
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Acceso exclusivo para personal registrado por el Administrador de{' '}
                <span className="text-slate-300 font-medium">La Calera</span>. El registro público se encuentra deshabilitado.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const scopeBadgeText =
    profile.role === 'Administrador'
      ? 'Alcance Global'
      : profile.assignedSectorIds.length > 0 || profile.assignedGalponIds.length > 0
      ? `${profile.assignedSectorIds.length} sect. / ${profile.assignedGalponIds.length} galp.`
      : profile.assignedProject && profile.assignedProject !== 'TODOS'
      ? `Proyecto: ${profile.assignedProject}`
      : 'Alcance Global';

  return (
    <AuthContext.Provider
      value={{
        profile,
        openUserAdminModal: () => setIsUserAdminOpen(true),
        logout: handleLogout
      }}
    >
      <div className="min-h-screen flex flex-col bg-slate-100">
        {/* Barra Superior de Sesión, Rol y Alcance */}
        <div className="bg-slate-900 text-slate-100 border-b border-slate-800 px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs z-40">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>{profile.role}</span>
            </span>
            <span className="text-slate-200 font-medium truncate max-w-[200px] sm:max-w-none">
              {profile.displayName}
            </span>
            {profile.dni && (
              <span className="text-slate-400 hidden md:inline">
                (DNI: {profile.dni})
              </span>
            )}
            <span className="text-slate-400 hidden lg:inline">
              • {profile.email}
            </span>
            <span className="text-[11px] text-slate-300 bg-slate-800 border border-slate-700 px-2 py-0.5 rounded">
              {scopeBadgeText}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {profile.role === 'Administrador' && (
              <button
                type="button"
                onClick={() => setIsUserAdminOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition shadow-sm cursor-pointer"
              >
                <Users className="w-3.5 h-3.5" />
                <span>Usuarios y Roles</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-red-950/80 hover:text-red-200 hover:border-red-800 border border-slate-700 text-slate-300 font-medium transition cursor-pointer"
              title="Cerrar sesión activa"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Cerrar Sesión</span>
            </button>
          </div>
        </div>

        {/* Contenido Principal de la Aplicación */}
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
