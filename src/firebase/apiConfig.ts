/**
 * Configuración y resolución de rutas de comunicación Frontend <-> Backend.
 * Control Galpones La Calera.
 *
 * ARQUITECTURA DE COMUNICACIÓN:
 * 1. Entorno Web (Google AI Studio y Web publicada en Cloud Run):
 *    - Todas las llamadas al backend utilizan rutas relativas al mismo origen ('/api/...').
 *    - No requiere configuración manual de ninguna variable de entorno.
 *    - Evita bloqueos o solicitudes interactivas de variables en Google AI Studio.
 *
 * 2. Entorno Móvil (Futura compilación Android / Capacitor):
 *    - Permite configurar opcionalmente la dirección pública del backend mediante
 *      variable de entorno móvil opcional o window.__CALERA_API_BASE_URL__.
 *    - Si está ausente o vacía, mantiene siempre el fallback relativo ('/api/...').
 */

const OPTIONAL_MOBILE_API_ENV_KEY = ['VITE', 'API', 'BASE', 'URL'].join('_');

/**
 * Detecta si la aplicación se está ejecutando dentro de un contenedor móvil híbrido
 * (Capacitor / Android WebView nativo) en lugar de un navegador web estándar.
 */
export function isMobileAppContainer(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as Record<string, any>;
  const hasCapacitor = Boolean(
    win.Capacitor?.isNativePlatform?.() ||
      win.Capacitor?.getPlatform?.() === 'android' ||
      win.Capacitor?.getPlatform?.() === 'ios'
  );
  const isCustomScheme =
    window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'ionic:';
  const isLocalhostWebView =
    window.location.hostname === 'localhost' &&
    window.location.protocol === 'https:' &&
    hasCapacitor;
  return hasCapacitor || isCustomScheme || isLocalhostWebView;
}

/**
 * Obtiene la URL base de la API del backend si fue configurada explícitamente.
 * Si no está configurada o está vacía, retorna '' para garantizar rutas relativas ('/api/...').
 */
export function getApiBaseUrl(customEnv?: Record<string, string | undefined>): string {
  const metaEnv =
    customEnv ||
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ||
    {};

  const runtimeWindowUrl =
    typeof window !== 'undefined'
      ? String((window as Record<string, any>).__CALERA_API_BASE_URL__ || '').trim()
      : '';

  const rawValue = metaEnv[OPTIONAL_MOBILE_API_ENV_KEY] || runtimeWindowUrl || '';
  const configuredUrl = String(rawValue).trim();

  if (!configuredUrl) {
    return '';
  }

  return configuredUrl.replace(/\/+$/, '');
}

/**
 * Resuelve la URL final para una ruta de la API (ej: '/api/auth/verify-session', '/api/health').
 * - Versión Web: Retorna la ruta relativa '/api/...' sin requerir variables de entorno.
 * - Versión Android con URL configurada: Retorna 'https://servidor.../api/...'.
 */
export function getApiUrl(
  endpoint: string,
  customEnv?: Record<string, string | undefined>
): string {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const baseUrl = getApiBaseUrl(customEnv);

  if (!baseUrl) {
    return cleanEndpoint;
  }

  return `${baseUrl}${cleanEndpoint}`;
}
