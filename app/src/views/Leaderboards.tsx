import { useState } from "react";
import { fetchAllProfiles, fullName, type Profile, type With } from "../honor";
import { Knight } from "../Knight";
import { rankOf } from "../ranks";
import { useHonor, useLoad } from "../state";

type Board = "honorable" | "dishonorable" | "predictions";

const BOARDS: Record<Board, { title: string; blurb: string; value: (p: Profile) => number; unit: string; dir: 1 | -1 }> = {
  honorable: {
    title: "Most honorable",
    blurb: "The knights who always pay what they owe.",
    value: (p) => p.honorPoints.toNumber(),
    unit: "honor",
    dir: -1,
  },
  dishonorable: {
    title: "Least honorable",
    blurb: "The hall of shame. Dodge enough challenges and you end up here as a FUFLO.",
    value: (p) => p.honorPoints.toNumber(),
    unit: "honor",
    dir: 1,
  },
  predictions: {
    title: "Prediction points",
    blurb: "The sharpest calls in the realm, by all Prediction Points ever earned.",
    value: (p) => p.lifetimePredictionPoints.toNumber(),
    unit: "pts",
    dir: -1,
  },
};

const TOP = 25;

export function Leaderboards() {
  const { me } = useHonor();
  const [board, setBoard] = useState<Board>("honorable");
  const { data, error } = useLoad((p) => fetchAllProfiles(p), []);
  const b = BOARDS[board];

  const sorted = (data ?? [])
    .slice()
    .sort((x, y) => b.dir * (b.value(x.account) - b.value(y.account)) || tiebreak(board, x, y));
  const mine = sorted.findIndex((x) => x.account.authority.equals(me!));

  return (
    <div className="leaders">
      <header className="page-head center">
        <p className="eyebrow">The whole realm</p>
        <h1 className="title">Leaderboards</h1>
      </header>

      <div className="tabs tabs-big" role="tablist" aria-label="Leaderboard">
        {(Object.keys(BOARDS) as Board[]).map((k) => (
          <button key={k} role="tab" aria-selected={board === k} className={`tab-${k}`} onClick={() => setBoard(k)}>
            {BOARDS[k].title}
          </button>
        ))}
      </div>
      <p className="muted center">{b.blurb}</p>

      {error && <p className="error center">{error}</p>}
      {!data && !error && <p className="muted center pad">Summoning the realm…</p>}
      {data && sorted.length === 0 && <p className="empty">Nobody has joined yet.</p>}

      {data && sorted.length > 0 && (
        <>
          <Podium entries={sorted.slice(0, 3)} board={board} />
          <ol className="board" start={4}>
            {sorted.slice(3, TOP).map((x, i) => (
              <Row key={x.publicKey.toBase58()} x={x} place={i + 4} board={board} me={x.account.authority.equals(me!)} />
            ))}
          </ol>
          {mine >= TOP && (
            <ol className="board board-me" start={mine + 1}>
              <Row x={sorted[mine]} place={mine + 1} board={board} me />
            </ol>
          )}
          <p className="muted small center">{sorted.length} players in the realm.</p>
        </>
      )}
    </div>
  );
}

// Equal scores: fewer failures first on the honor boards, more right calls first on predictions.
function tiebreak(board: Board, x: With<Profile>, y: With<Profile>) {
  const shame = (p: Profile) => p.challengesFailed + p.challengesDeclined;
  if (board === "honorable") return shame(x.account) - shame(y.account);
  if (board === "dishonorable") return shame(y.account) - shame(x.account);
  return y.account.correctPredictions - x.account.correctPredictions;
}

function Podium({ entries, board }: { entries: With<Profile>[]; board: Board }) {
  const { me } = useHonor();
  // Visual order 2-1-3, so first place stands in the middle.
  const order = [entries[1], entries[0], entries[2]];
  return (
    <ol className={`podium podium-${board}`}>
      {order.map((x, i) => {
        if (!x) return <li key={i} className="podium-empty" aria-hidden />;
        const place = [2, 1, 3][i];
        const r = rankOf(x.account.honorPoints.toNumber()).rank;
        return (
          <li key={x.publicKey.toBase58()} className={`podium-${place} ${x.account.authority.equals(me!) ? "me" : ""}`} value={place}>
            <Knight rank={r.id} size={place === 1 ? 120 : 92} />
            <span className="podium-place">{place}</span>
            <strong>{fullName(x.account)}</strong>
            <span className={`rank-tag rank-${r.id}`}>{r.name}</span>
            <span className="podium-score">
              {BOARDS[board].value(x.account)} {BOARDS[board].unit}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Row({ x, place, board, me }: { x: With<Profile>; place: number; board: Board; me: boolean }) {
  const r = rankOf(x.account.honorPoints.toNumber()).rank;
  return (
    <li className={me ? "me" : ""} value={place}>
      <span className="place">{place}</span>
      <Knight rank={r.id} size={40} />
      <span className="who">
        {fullName(x.account)}
        {me && <span className="muted small"> (you)</span>}
      </span>
      <span className={`rank-tag rank-${r.id}`}>{r.name}</span>
      <span className="pts">
        {BOARDS[board].value(x.account)} <span className="muted small">{BOARDS[board].unit}</span>
      </span>
    </li>
  );
}
