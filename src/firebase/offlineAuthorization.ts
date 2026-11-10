const value = Number(import.meta.env?.VITE_OFFLINE_AUTH_MINUTES);
export const offlineAuthorizationMs = (Number.isInteger(value) && value >= 15 && value <= 1440 ? value : 480) * 60_000;
