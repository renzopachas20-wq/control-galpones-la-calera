import type { UserProfile } from './authService';

export function preferCurrentProfile(known: UserProfile, received: UserProfile): UserProfile {
  const revision = (known.profileVersion ?? 0) - (received.profileVersion ?? 0);
  if (revision) return revision > 0 ? known : received;
  return (known.credentialVersion ?? 0) > (received.credentialVersion ?? 0) ? known : received;
}
