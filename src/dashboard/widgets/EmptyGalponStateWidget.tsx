import React from 'react';
import { Building2 } from 'lucide-react';

export interface EmptyGalponStateWidgetProps {
  onGoToCatalog: () => void;
  onGoToProjects: () => void;
}

/**
 * Componente modular independiente: Estado inicial cuando aún no hay un galpón seleccionado.
 */
export const EmptyGalponStateWidget: React.FC<EmptyGalponStateWidgetProps> = ({
  onGoToCatalog,
  onGoToProjects
}) => {
  return (
    <div className="bg-white rounded-2xl p-8 text-center border border-slate-200 shadow-xs">
      <Building2 className="w-10 h-10 text-[#0f6b38] mx-auto mb-2" />
      <h2 className="text-base font-extrabold text-slate-900">
        La aplicación está lista y limpia para empezar desde cero
      </h2>
      <p className="text-xs text-slate-500 mt-1 max-w-lg mx-auto">
        Primero configura tus actividades y materiales en el{' '}
        <strong>Catálogo Maestro</strong> o crea directamente tu primer{' '}
        <strong>Sector y Galpón</strong>.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        <button
          onClick={onGoToCatalog}
          className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold"
        >
          1. Ir a Catálogo Maestro y Plantillas
        </button>
        <button
          onClick={onGoToProjects}
          className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold"
        >
          2. Crear Sector y Galpón
        </button>
      </div>
    </div>
  );
};
