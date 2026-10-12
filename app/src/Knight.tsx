// One knight per rank, drawn in the same flat geometric style as the HONOR emblem.
import { useId } from "react";
import type { RankId } from "./ranks";

type Look = {
  armor: string;
  shade: string;
  cape: string;
  visor: string;
  accent: string;
  plume?: string;
  plumeShape?: "sweep" | "droop" | "grand";
  crest?: string;
  brim?: boolean;
  crown?: boolean;
  halo?: boolean;
  cross?: boolean;
  battered?: boolean;
};

const LOOKS: Record<RankId, Look> = {
  fuflo: {
    armor: "#857b6d", shade: "#5c544a", cape: "#9a8466", visor: "#2a2520", accent: "#6b4a2b",
    plume: "#a39573", plumeShape: "droop", battered: true,
  },
  squire: { armor: "#a0714a", shade: "#6e4a2c", cape: "#c9a175", visor: "#2b1d12", accent: "#e2bf95", brim: true },
  knight: { armor: "#9aaecb", shade: "#62789a", cape: "#c3d0e2", visor: "#1d2533", accent: "#eef2f8", plume: "#3b82f6", plumeShape: "sweep" },
  paladin: { armor: "#6a2bd9", shade: "#47189a", cape: "#a48cf2", visor: "#1b1430", accent: "#e8b52a", plume: "#ece6ff", plumeShape: "sweep", cross: true },
  champion: { armor: "#59606e", shade: "#383d48", cape: "#d62f2f", visor: "#15171c", accent: "#f5c542", crest: "#ef4444" },
  grandmaster: {
    armor: "#e3b43f", shade: "#a87a12", cape: "#6a2bd9", visor: "#3b2a05", accent: "#fff3c4",
    plume: "#a48cf2", plumeShape: "grand", crown: true, halo: true,
  },
};

const PLUMES = {
  sweep: "M98 54 C100 30 92 14 70 12 C54 11 44 20 36 30 C52 26 66 28 74 36 C82 44 86 50 88 56 Z",
  droop: "M96 56 C90 48 70 46 57 57 C49 64 46 76 48 88 C54 75 62 68 74 65 C84 62 90 61 93 60 Z",
  grand: "M100 52 C104 24 94 4 66 2 C46 1 32 12 24 26 C44 18 62 20 72 30 C82 40 86 48 88 56 Z",
};

export function Knight({ rank, size = 120, title }: { rank: RankId; size?: number; title?: string }) {
  const L = LOOKS[rank];
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={`knight knight-${rank}`}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <radialGradient id={`halo${id}`}>
          <stop offset="0.45" stopColor="#ffe08a" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffe08a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`shine${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {L.halo && <circle cx="100" cy="92" r="96" fill={`url(#halo${id})`} />}

      {/* cape and shoulders */}
      <path d="M100 158 L14 198 Q26 150 70 140 Z" fill={L.cape} />
      <path d="M100 158 L186 198 Q174 150 130 140 Z" fill={L.cape} />
      <path d="M36 198 Q44 150 100 148 Q156 150 164 198 Z" fill={L.shade} />
      <path d="M52 198 Q60 162 100 160 Q140 162 148 198 Z" fill={L.armor} />
      {L.cross ? (
        <g fill={L.accent}>
          <rect x="96" y="164" width="8" height="28" rx="2" />
          <rect x="86" y="172" width="28" height="8" rx="2" />
        </g>
      ) : (
        <circle cx="100" cy="176" r="9" fill={L.accent} />
      )}

      <g transform={L.battered ? "rotate(-9 100 100)" : undefined}>
        {L.plume && <path d={PLUMES[L.plumeShape ?? "sweep"]} fill={L.plume} />}
        {L.crest && <path d="M68 62 Q100 4 132 62 Q100 38 68 62 Z" fill={L.crest} />}

        {/* helmet */}
        <path d="M62 100 Q62 52 100 50 Q138 52 138 100 L138 128 L118 150 L100 156 L82 150 L62 128 Z" fill={L.armor} />
        <path d="M100 50 Q138 52 138 100 L138 128 L118 150 L100 156 Z" fill={L.shade} opacity="0.35" />
        <path d="M66 98 Q66 58 100 54 L100 70 Q80 74 74 98 Z" fill={`url(#shine${id})`} />
        <path d="M100 52 L100 96" stroke={L.accent} strokeWidth="3" strokeLinecap="round" opacity="0.7" />
        <path d="M70 98 L130 98 L124 108 L106 108 L103 142 L97 142 L94 108 L76 108 Z" fill={L.visor} />

        {L.brim && <path d="M46 86 Q100 66 154 86 Q100 96 46 86 Z" fill={L.shade} />}
        {L.crown && (
          <path d="M70 58 L68 32 L84 44 L100 22 L116 44 L132 32 L130 58 Z" fill={L.accent} stroke={L.shade} strokeWidth="2" strokeLinejoin="round" />
        )}
        {L.battered && (
          <g stroke={L.visor} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M116 58 L109 72 L118 80 L111 94" />
            <path d="M74 120 l8 -4" />
            <circle cx="82" cy="78" r="5" fill={L.shade} stroke="none" />
          </g>
        )}
        {L.battered && (
          <g transform="rotate(35 120 118)" fill="#e9dcc0" stroke="#b9a785" strokeWidth="1">
            <rect x="104" y="114" width="32" height="9" rx="2" />
            <rect x="115.5" y="102.5" width="9" height="32" rx="2" />
          </g>
        )}
      </g>
    </svg>
  );
}
