import React, { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  Mail,
  LogOut,
  Shield,
  Users,
  AlertCircle,
  CheckCircle2,
  ArrowLeft,
  KeyRound,
} from 'lucide-react';
import {
  type UserProfile,
  loginWithEmailAndPassword,
  sendPasswordRecoveryEmail,
  logoutUser,
  subscribeToAuthChanges,
  subscribeToCurrentUserProfile,
  fetchOrBootstrapProfile,
} from '../firebase/authService';
import { UserAdminModal } from './UserAdminModal';

interface AuthGateProps {
  children: React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [currentUserProfile, setCurrentUserProfile] = useState<UserProfile | null>(null);

  // Estado del formulario de acceso / recuperación
  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [infoBanner, setInfoBanner] = useState<string>('');

  // Modal de Administración de Usuarios (solo Administrador)
  const [isUserAdminOpen, setIsUserAdminOpen] = useState<boolean>(false);

  useEffect(() => {
    let profileUnsub: (() => void) | null = null;

    const authUnsub = subscribeToAuthChanges(async (firebaseUser) => {
      if (profileUnsub) {
        profileUnsub();
        profileUnsub = null;
      }

      if (!firebaseUser) {
        setCurrentUserProfile(null);
        setAuthReady(true);
        return;
      }

      try {
        const initialProfile = await fetchOrBootstrapProfile(firebaseUser);
        if (!initialProfile.active) {
          await logoutUser();
          setCurrentUserProfile(null);
          setErrorBanner(
            'Tu cuenta ha sido desactivada por el Administrador y no tiene permiso para acceder al sistema.'
          );
          setAuthReady(true);
          return;
        }

        setCurrentUserProfile(initialProfile);
        setAuthReady(true);

        // Suscripción en tiempo real al perfil para cortar el acceso inmediatamente si se desactiva la cuenta
        profileUnsub = subscribeToCurrentUserProfile(
          firebaseUser.uid,
          async (liveProfile) => {
            if (!liveProfile) {
              await logoutUser();
              setCurrentUserProfile(null);
              setErrorBanner(
                'Tu perfil de usuario ya no se encuentra disponible. Contacta al Administrador.'
              );
              return;
            }
            if (!liveProfile.active) {
              await logoutUser();
              setCurrentUserProfile(null);
              setIsUserAdminOpen(false);
              setErrorBanner(
                'Tu cuenta ha sido desactivada por el Administrador. Tu sesión se ha cerrado por seguridad.'
              );
              return;
            }
            setCurrentUserProfile(liveProfile);
          },
          async () => {
            // Si el token venció o las reglas bloquean la lectura del perfil
            await logoutUser();
            setCurrentUserProfile(null);
            setErrorBanner('Tu sesión ha expirado. Por favor inicia sesión nuevamente.');
          }
        );
      } catch (err) {
        await logoutUser();
        setCurrentUserProfile(null);
        setErrorBanner(err instanceof Error ? err.message : String(err));
        setAuthReady(true);
      }
    });

    return () => {
      if (profileUnsub) profileUnsub();
      authUnsub();
    };
  }, []);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner('');
    setInfoBanner('');
    setSubmitting(true);

    try {
      const profile = await loginWithEmailAndPassword(email, password);
      setCurrentUserProfile(profile);
      setPassword('');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecoverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner('');
    setInfoBanner('');
    setSubmitting(true);

    try {
      await sendPasswordRecoveryEmail(email);
      setInfoBanner(
        `Se ha enviado un enlace de recuperación de contraseña a ${email.trim().toLowerCase()}. Revisa tu bandeja de entrada y correo no deseado.`
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setIsUserAdminOpen(false);
    await logoutUser();
    setCurrentUserProfile(null);
    setPassword('');
    setInfoBanner('Has cerrado sesión correctamente.');
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md w-full text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-[#0f6b38] text-white font-black text-lg flex items-center justify-center mx-auto shadow-sm">
            PA
          </div>
          <h2 className="text-base font-bold text-slate-800">
            Verificando sesión segura...
          </h2>
          <p className="text-xs text-slate-500">
            Control Galpones La Calera • Proyectos Automatizados
          </p>
        </div>
      </div>
    );
  }

  // Si el usuario NO está autenticado o no tiene perfil activo -> Mostrar Pantalla de Acceso
  if (!currentUserProfile) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col justify-center items-center p-4 sm:p-6">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
          {/* Cabecera con identidad visual de Control Galpones La Calera */}
          <div className="bg-[#0f6b38] px-6 py-7 text-white text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center mx-auto text-xl font-black tracking-wider shadow-xs">
              PA
            </div>
            <h1 className="text-xl font-extrabold tracking-tight">
              Control Galpones La Calera
            </h1>
            <p className="text-xs text-emerald-100 font-medium">
              Proyectos Galpones Automatizados • Acceso Corporativo
            </p>
          </div>

          <div className="p-6 sm:p-7 space-y-5">
            {errorBanner && (
              <div
                role="alert"
                className="flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs sm:text-sm"
              >
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="flex-1 font-medium">{errorBanner}</div>
              </div>
            )}

            {infoBanner && (
              <div
                role="status"
                className="flex items-start gap-2.5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs sm:text-sm"
              >
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="flex-1 font-medium">{infoBanner}</div>
              </div>
            )}

            {mode === 'login' ? (
              <form onSubmit={handleLoginSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="login-email"
                    className="block text-xs font-bold text-slate-700 uppercase mb-1.5"
                  >
                    Correo Electrónico
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="login-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="usuario@lacalera.pe"
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-300 bg-slate-50 focus:bg-white text-sm text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38] transition"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="login-password"
                    className="block text-xs font-bold text-slate-700 uppercase mb-1.5"
                  >
                    Contraseña
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="login-password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Ingresa tu contraseña"
                      className="w-full pl-10 pr-11 py-2.5 rounded-xl border border-slate-300 bg-slate-50 focus:bg-white text-sm text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38] transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      title={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 transition"
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setErrorBanner('');
                      setInfoBanner('');
                      setMode('recover');
                    }}
                    className="text-xs font-bold text-[#0f6b38] hover:underline"
                  >
                    ¿Olvidaste tu contraseña? Recuperar acceso
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-3 px-4 rounded-xl bg-[#0f6b38] hover:bg-[#0b522a] disabled:opacity-60 text-white font-bold text-sm shadow-sm transition cursor-pointer"
                >
                  {submitting ? 'Verificando credenciales...' : 'Iniciar Sesión'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleRecoverSubmit} className="space-y-4">
                <div className="space-y-1">
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <KeyRound className="w-4 h-4 text-[#0f6b38]" />
                    Recuperación de Contraseña
                  </h2>
                  <p className="text-xs text-slate-600">
                    Ingresa el correo electrónico de tu cuenta autorizada para enviarte un enlace de restablecimiento.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="recover-email"
                    className="block text-xs font-bold text-slate-700 uppercase mb-1.5"
                  >
                    Correo Electrónico Registrado
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="recover-email"
                      name="recoverEmail"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="usuario@lacalera.pe"
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-300 bg-slate-50 focus:bg-white text-sm text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38] transition"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-3 px-4 rounded-xl bg-[#0f6b38] hover:bg-[#0b522a] disabled:opacity-60 text-white font-bold text-sm shadow-sm transition cursor-pointer"
                >
                  {submitting
                    ? 'Enviando correo de recuperación...'
                    : 'Enviar enlace de recuperación'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setErrorBanner('');
                    setInfoBanner('');
                    setMode('login');
                  }}
                  className="w-full py-2.5 px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs inline-flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Volver a Iniciar Sesión
                </button>
              </form>
            )}

            <div className="pt-3 border-t border-slate-200 text-center">
              <p className="text-[11px] text-slate-500">
                Acceso restringido a personal autorizado. El alta de cuentas es realizada exclusivamente por el Administrador del sistema.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Barra superior de sesión activa e identificación de rol */}
      <div className="bg-slate-900 text-white px-3 sm:px-6 py-2 text-xs flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 z-40">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-900/70 text-emerald-200 border border-emerald-700/60 font-bold">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
            {currentUserProfile.role}
          </span>
          <span className="font-semibold text-slate-100">
            {currentUserProfile.displayName}
          </span>
          <span className="text-slate-400 hidden sm:inline">
            ({currentUserProfile.email})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {currentUserProfile.role === 'Administrador' && (
            <button
              type="button"
              onClick={() => setIsUserAdminOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0f6b38] hover:bg-[#138446] text-white font-bold text-xs transition cursor-pointer"
            >
              <Users className="w-3.5 h-3.5" />
              Gestión de Usuarios
            </button>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-red-900/80 text-slate-200 hover:text-white border border-slate-700 font-semibold text-xs transition cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Cerrar Sesión
          </button>
        </div>
      </div>

      {/* Aplicación principal conservada íntegramente */}
      <div className="flex-1">{children}</div>

      {/* Modal de Administración de Usuarios (Exclusivo Administrador) */}
      {currentUserProfile.role === 'Administrador' && (
        <UserAdminModal
          isOpen={isUserAdminOpen}
          onClose={() => setIsUserAdminOpen(false)}
          currentAdmin={currentUserProfile}
        />
      )}
    </div>
  );
};
