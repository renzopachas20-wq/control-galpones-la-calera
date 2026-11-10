import type { CredentialOperationStatus, UserProfile } from './authService';
import { preferCurrentProfile } from './profileVersion.ts';

export interface EmergencyStatus {
  operation: CredentialOperationStatus;
  user: UserProfile | null;
  currentAuthentication?: { disabled: boolean; profileVersion: number } | null;
}

export function describeEmergencyStatus(status: EmergencyStatus, known?: UserProfile): string {
  const { operation, user, currentAuthentication } = status;
  const current = user && known ? preferCurrentProfile(user, known) : user;
  const result = operation.state === 'completed'
    ? current?.active ? 'La operación de desactivación se completó anteriormente.' : 'Operación de desactivación completada.'
    : 'Operación de desactivación pendiente de confirmación.';
  const profile = current ? current.active ? 'ACTIVA' : 'INACTIVA. Bloqueo operativo confirmado' : 'pendiente de consulta';
  const authentication = current && currentAuthentication?.profileVersion === (current.profileVersion ?? 0)
    ? currentAuthentication.disabled ? 'deshabilitada' : 'habilitada'
    : 'pendiente de consulta';
  const revocation = operation.refreshRevoked ? 'confirmada' : 'pendiente';
  const reconciliation = operation.state === 'pending' ? ' Consulte Operaciones.' : '';
  const audit = operation.audit === 'pending' ? ' Bitácora pendiente.' : '';
  return `${result} Estado actual de la cuenta: ${profile}. Firebase Authentication: ${authentication}. ` +
    `Revocación de esta operación: ${revocation}.${reconciliation}${audit} Referencia ${operation.id}.`;
}
