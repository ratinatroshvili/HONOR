// Ranks come from Honor Points (keeping your word), which can go negative.
export type RankId = "fuflo" | "squire" | "knight" | "paladin" | "champion" | "grandmaster";

export type Rank = {
  id: RankId;
  name: string;
  /** Lowest Honor Points for this rank (inclusive). */
  min: number;
  motto: string;
};

export const RANKS: Rank[] = [
  { id: "fuflo", name: "FUFLO", min: -Infinity, motto: "Talks big, never pays up. Below zero honor." },
  { id: "squire", name: "Squire", min: 0, motto: "Every knight starts here. Keep your word to rise." },
  { id: "knight", name: "Knight", min: 50, motto: "Proven. Friends trust your calls and your follow-through." },
  { id: "paladin", name: "Paladin", min: 150, motto: "A pillar of the group. You always pay what you owe." },
  { id: "champion", name: "Champion", min: 350, motto: "Feared in predictions, respected in defeat." },
  { id: "grandmaster", name: "Grand Master", min: 750, motto: "Legend of the order. Your word is law." },
];

export function rankOf(honor: number): { rank: Rank; next: Rank | null; progress: number } {
  let i = RANKS.length - 1;
  while (i > 0 && honor < RANKS[i].min) i--;
  const rank = RANKS[i];
  const next = RANKS[i + 1] ?? null;
  // Progress through the current rank (FUFLO climbs toward 0).
  const from = rank.id === "fuflo" ? Math.min(honor, -50) : rank.min;
  const progress = next ? Math.max(0, Math.min(1, (honor - from) / (next.min - from))) : 1;
  return { rank, next, progress };
}
