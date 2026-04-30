import { Box, Ruler } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  CREATION_MODE_OPTIONS,
  type CreationModeType,
} from '@/utils/creationModeOptions';

type CreationModeCardsProps = {
  selectedType: CreationModeType;
  onTypeChange: (type: CreationModeType) => void;
  className?: string;
};

export function CreationModeCards({
  selectedType,
  onTypeChange,
  className,
}: CreationModeCardsProps) {
  return (
    <div className={cn('grid w-full gap-3 md:grid-cols-2', className)}>
      {CREATION_MODE_OPTIONS.map((option) => {
        const isSelected = option.type === selectedType;
        const Icon = option.type === 'parametric' ? Ruler : Box;

        return (
          <button
            key={option.type}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onTypeChange(option.type)}
            className={cn(
              'group relative flex min-h-[174px] overflow-hidden rounded-xl border bg-adam-background-2 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-adam-blue focus-visible:ring-offset-2 focus-visible:ring-offset-adam-bg-secondary-dark',
              isSelected
                ? 'border-adam-blue/80 shadow-[0_0_0_1px_rgba(15,95,244,0.32),0_18px_44px_rgba(0,0,0,0.22)]'
                : 'border-white/10 shadow-[0_14px_34px_rgba(0,0,0,0.16)] hover:border-white/20 hover:bg-[#1d1e1e]',
            )}
          >
            <div className="relative z-10 flex w-full flex-col justify-between p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div
                    className={cn(
                      'mb-3 flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                      isSelected
                        ? 'border-adam-blue/40 bg-adam-blue/15 text-adam-blue'
                        : 'border-white/10 bg-white/[0.03] text-adam-text-secondary group-hover:text-adam-text-primary',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <h2 className="text-base font-semibold leading-tight text-adam-text-primary">
                    {option.title}
                  </h2>
                  <p className="mt-1 max-w-[18rem] text-sm leading-5 text-adam-text-secondary">
                    {option.description}
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                    isSelected
                      ? 'border-adam-blue/30 bg-adam-blue/10 text-adam-blue'
                      : 'border-white/10 bg-white/[0.03] text-adam-text-tertiary',
                  )}
                >
                  {isSelected ? 'Selected' : 'Choose'}
                </span>
              </div>

              {option.type === 'parametric' ? (
                <CadEngineeringPreview selected={isSelected} />
              ) : (
                <PrintableMeshPreview selected={isSelected} />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function CadEngineeringPreview({ selected }: { selected: boolean }) {
  return (
    <div className="mt-4 h-[88px] overflow-hidden rounded-lg border border-white/10 bg-[#161717]">
      <svg
        viewBox="38 8 285 96"
        role="img"
        aria-label="CAD bracket preview"
        className="h-full w-full"
      >
        <defs>
          <pattern
            id="cad-grid"
            width="18"
            height="18"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 18 0 L 0 0 0 18"
              fill="none"
              stroke="rgba(15,95,244,0.13)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="360" height="118" fill="url(#cad-grid)" />
        <path
          d="M86 80h134c16 0 26-10 26-24V35h-42v22H94V35H52v21c0 14 14 24 34 24Z"
          fill={selected ? 'rgba(15,95,244,0.14)' : 'rgba(255,255,255,0.04)'}
          stroke={selected ? '#2F7BFF' : '#8A8A8A'}
          strokeWidth="2"
        />
        <circle cx="78" cy="56" r="13" fill="#171818" stroke="#A9A9A9" />
        <circle cx="220" cy="56" r="13" fill="#171818" stroke="#A9A9A9" />
        <path
          d="M268 31h36v49h-36zM286 31v49M268 55h36"
          fill="rgba(255,255,255,0.03)"
          stroke={selected ? '#7AA7FF' : '#686868'}
          strokeWidth="2"
        />
        <path
          d="M52 94h194M52 90v8M246 90v8M268 94h36M268 90v8M304 90v8"
          stroke="#5A5A5A"
          strokeWidth="1.5"
        />
        <path d="M139 93l-8-4v8l8-4Zm20 0 8-4v8l-8-4Z" fill="#5A5A5A" />
      </svg>
    </div>
  );
}

function PrintableMeshPreview({ selected }: { selected: boolean }) {
  const accent = selected ? '#2F7BFF' : '#7B7B7B';

  return (
    <div className="mt-4 h-[88px] overflow-hidden rounded-lg border border-white/10 bg-[#161717]">
      <svg
        viewBox="46 8 280 96"
        role="img"
        aria-label="Printable mesh figurine preview"
        className="h-full w-full"
      >
        <path
          d="M37 91h286M55 101h250M77 81h208M103 71h157"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="1"
        />
        <g transform="translate(58 12)">
          <path
            d="M80 78c0 9 55 9 55 0 0-10-13-16-28-16s-27 6-27 16Z"
            fill="#545454"
            stroke="#929292"
          />
          <path
            d="M94 35c-5 9-3 26 2 33 7 7 22 7 29 0 5-7 7-24 2-33H94Z"
            fill="#777"
            stroke="#B0B0B0"
            strokeWidth="1.5"
          />
          <path
            d="M64 41c7-24 26-35 48-35s42 11 48 35c3 11-5 20-20 20H84c-15 0-23-9-20-20Z"
            fill="#A4A4A4"
            stroke="#D0D0D0"
            strokeWidth="1.5"
          />
          <path
            d="M72 44h24l-12 17m12-17 18-32 16 32m0 0 22 1-12 16m-10-17-18 17-16-17m16-32v32"
            fill="none"
            stroke={accent}
            strokeWidth="1.3"
            opacity="0.88"
          />
          <g fill={accent}>
            <circle cx="72" cy="44" r="2" />
            <circle cx="96" cy="44" r="2" />
            <circle cx="114" cy="12" r="2" />
            <circle cx="130" cy="44" r="2" />
            <circle cx="152" cy="45" r="2" />
            <circle cx="84" cy="61" r="2" />
            <circle cx="140" cy="61" r="2" />
          </g>
          <path d="M104 51h7M121 51h7" stroke="#303030" strokeWidth="2" />
          <path
            d="M108 61c4 3 10 3 14 0"
            fill="none"
            stroke="#303030"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
        <g className="text-[10px] font-medium">
          <rect x="232" y="18" width="36" height="18" rx="5" fill="#252626" />
          <text x="250" y="30" textAnchor="middle" fill="#ADADAD">
            Draft
          </text>
          <rect x="274" y="18" width="62" height="18" rx="5" fill="#252626" />
          <text x="305" y="30" textAnchor="middle" fill="#ADADAD">
            Max Quality
          </text>
          <rect x="248" y="42" width="56" height="18" rx="5" fill="#252626" />
          <text x="276" y="54" textAnchor="middle" fill="#ADADAD">
            Multiview
          </text>
        </g>
      </svg>
    </div>
  );
}
