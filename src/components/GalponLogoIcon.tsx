import React from 'react';

interface GalponLogoIconProps {
  /**
   * Variante visual según el fondo donde se ubica el logotipo:
   * - 'header': sobre fondo verde institucional (#0f6b38), contenedor blanco con símbolo verde
   * - 'sidebar': sobre encabezado de barra lateral (#0f6b38), contenedor blanco con símbolo verde
   * - 'login': sobre tarjeta oscura de inicio de sesión, contenedor verde institucional con símbolo blanco/esmeralda
   * - 'inline': solo el SVG vectorial adaptable a currentColor
   */
  variant?: 'header' | 'sidebar' | 'login' | 'inline';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Símbolo gráfico corporativo de Control Galpones La Calera:
 * Galpón industrial automatizado visto de frente (nave industrial con techo a dos aguas,
 * linterna superior de ventilación, pórtico estructural y líneas geométricas de climatización).
 * Sin letras, iniciales ni textos.
 */
export const GalponLogoIcon: React.FC<GalponLogoIconProps> = ({
  variant = 'header',
  size = 'md',
  className = ''
}) => {
  const containerDimensions =
    size === 'sm'
      ? 'w-8 h-8 rounded-lg'
      : size === 'lg'
        ? 'w-12 h-12 rounded-xl'
        : 'w-9 h-9 rounded-lg';

  const svgDimensions =
    size === 'sm'
      ? 'w-5 h-5'
      : size === 'lg'
        ? 'w-7 h-7'
        : 'w-5 h-5';

  const renderSvg = (strokeColorClass: string) => (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-testid="galpon-industrial-logo-svg"
      className={`${svgDimensions} ${strokeColorClass} shrink-0`}
    >
      {/* Cumbrera / Linterna de ventilación automatizada superior */}
      <path
        d="M12.5 6.5L16 4.5L19.5 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Techo industrial a dos aguas (alero ancho simétrico) */}
      <path
        d="M3 14L16 6.5L29 14"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Estructura envolvente de nave industrial y base */}
      <path
        d="M5.5 12.8V26.5H26.5V12.8"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Línea base de cimentación */}
      <path
        d="M3 26.5H29"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      {/* Pórtico central y niveles de baterías/ventilación automatizada */}
      <rect
        x="9.5"
        y="15"
        width="13"
        height="11.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M9.5 18.8H22.5M9.5 22.6H22.5M16 15V26.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );

  if (variant === 'inline') {
    return renderSvg(className || 'text-[#0f6b38]');
  }

  if (variant === 'login') {
    return (
      <div
        data-testid="galpon-logo-login"
        className={`${containerDimensions} bg-[#0f6b38] border border-emerald-500/40 shadow-md flex items-center justify-center shrink-0 ${className}`}
      >
        {renderSvg('text-white')}
      </div>
    );
  }

  return (
    <div
      data-testid={`galpon-logo-${variant}`}
      className={`${containerDimensions} bg-white text-[#0f6b38] shadow-xs flex items-center justify-center shrink-0 ${className}`}
    >
      {renderSvg('text-[#0f6b38]')}
    </div>
  );
};
