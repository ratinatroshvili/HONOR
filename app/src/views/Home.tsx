import { useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { RULES, actions, fetchMyGroups, fullName, honorRate, randomInviteCode, type Group, type With } from "../honor";
import { Knight } from "../Knight";
import { rankOf } from "../ranks";
import { go, store, useHonor, useLoad, useNow } from "../state";
import { SELF_PAY_LAMPORTS, topUpWithPhantom } from "../sponsor";
import { useConnection } from "@solana/wallet-adapter-react";

export function Home() {
  const { profile, program, me, run, busy } = useHonor();
  const { data: groups, error } = useLoad((p) => fetchMyGroups(p, me!), []);
  const [groupName, setGroupName] = useState("");
  const [link, setLink] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const p = profile!;
  const honor = p.honorPoints.toNumber();
  const { rank, next, progress } = rankOf(honor);
  const rate = honorRate(p);
  const active = groups?.filter((g) => !g.account.archived) ?? [];
  const removed = groups?.filter((g) => g.account.archived) ?? [];

  const createGroup = async () => {
    const code = randomInviteCode();
    let created: PublicKey | null = null;
    const ok = await run("Founding your group…", "Group founded. Share the invite link with friends.", async () => {
      created = await actions.createGroup(program, me!, groupName.trim(), code);
    });
    if (ok && created) {
      store.set(`invite:${(created as PublicKey).toBase58()}`, code);
      go(`/g/${(created as PublicKey).toBase58()}`);
    }
  };

  const openLink = () => {
    const m = link.match(/join\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([a-z0-9]+)/i);
    if (m) go(`/join/${m[1]}/${m[2]}`);
  };

  return (
    <div className="home">
      <section className={`hall-card rank-${rank.id}`} aria-labelledby="me">
        <div className="hall-knight">
          <Knight rank={rank.id} size={170} title={`${rank.name} knight`} />
        </div>
        <div className="hall-info">
          <p className="eyebrow">{rank.name}</p>
          <h1 id="me" className="title">{fullName(p)}</h1>
          <p className="muted">{rank.motto}</p>
          <div className="rank-progress" aria-label={next ? `${Math.round(progress * 100)}% of the way to ${next.name}` : "Highest rank"}>
            <div className="bar">
              <span style={{ width: `${progress * 100}%` }} />
            </div>
            <span className="small muted">
              {next ? `${next.min - honor} Honor Points to ${next.name}` : "You've reached the top of the order."}
            </span>
          </div>
        </div>
        <div className="score-tiles">
          <div className="tile tile-honor">
            <span className="tile-num">{honor}</span>
            <span className="tile-label">Honor Points</span>
            <span className="tile-help">Keeping your word</span>
          </div>
          <div className="tile tile-pp">
            <span className="tile-num">{p.predictionPoints.toString()}</span>
            <span className="tile-label">Prediction Points</span>
            <span className="tile-help">{p.lifetimePredictionPoints.toString()} earned in total</span>
          </div>
        </div>
      </section>

      <dl className="stats">
        <div>
          <dt>Right calls</dt>
          <dd>
            {p.correctPredictions} / {p.correctPredictions + p.wrongPredictions}
          </dd>
        </div>
        <div>
          <dt>Challenges done</dt>
          <dd>{p.challengesCompleted}</dd>
        </div>
        <div>
          <dt>Failed or declined</dt>
          <dd>{p.challengesFailed + p.challengesDeclined}</dd>
        </div>
        <div>
          <dt>Honor rate</dt>
          <dd title="Challenges completed out of all challenges owed">{rate === null ? "–" : `${rate}%`}</dd>
        </div>
        <div>
          <dt>Streak</dt>
          <dd>
            {p.currentStreak} <span className="muted small">best {p.bestStreak}</span>
          </dd>
        </div>
        <div>
          <dt>Shields</dt>
          <dd>{p.shields}</dd>
        </div>
      </dl>

      <Purse />

      <section className="armory panel">
        <div className="armory-icon" aria-hidden>
          <svg viewBox="0 0 48 56" width="44" height="52">
            <path d="M24 2 L44 9 V26 C44 40 35 49 24 54 C13 49 4 40 4 26 V9 Z" fill="var(--violet)" stroke="var(--gold)" strokeWidth="3" />
            <path d="M24 12 V44 M14 24 H34" stroke="var(--gold)" strokeWidth="4" strokeLinecap="round" />
          </svg>
        </div>
        <div>
          <h2 className="section-title">The armory</h2>
          <p className="muted small">
            A shield skips one challenge without losing Honor Points or your streak. Costs {RULES.shieldCost} Prediction Points.
          </p>
        </div>
        <button
          className="btn btn-quiet"
          disabled={busy || p.predictionPoints.toNumber() < RULES.shieldCost}
          onClick={() => run("Forging a shield…", "Shield ready. Use it to skip one challenge.", () => actions.buyShield(program, me!))}
        >
          Buy a shield
        </button>
      </section>

      <section className="groups" aria-labelledby="groups">
        <h2 id="groups" className="section-title">Your groups</h2>
        {error && <p className="error">{error}</p>}
        {groups === undefined && !error && <p className="muted">Loading groups…</p>}
        {groups && active.length === 0 && (
          <p className="empty">
            {removed.length ? "No active groups." : "You're not in a group yet."} Found one below and send the invite link to
            your friends.
          </p>
        )}
        <ul className="group-grid">
          {active.map((g) => (
            <GroupCard key={g.publicKey.toBase58()} g={g} />
          ))}
        </ul>
        {removed.length > 0 && (
          <div className="removed">
            <button className="link small" onClick={() => setShowRemoved(!showRemoved)} aria-expanded={showRemoved}>
              {showRemoved ? "Hide" : "Show"} {removed.length} removed {removed.length === 1 ? "group" : "groups"}
            </button>
            {showRemoved && (
              <ul className="group-grid">
                {removed.map((g) => (
                  <GroupCard key={g.publicKey.toBase58()} g={g} />
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="grid2 forms">
          <form
            className="panel stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (groupName.trim()) createGroup();
            }}
          >
            <label className="field">
              <span>Found a group</span>
              <input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={32} placeholder="Friday Crew" />
            </label>
            <button className="btn" disabled={!groupName.trim() || busy}>
              Found group
            </button>
          </form>
          <form
            className="panel stack"
            onSubmit={(e) => {
              e.preventDefault();
              openLink();
            }}
          >
            <label className="field">
              <span>Got an invite link?</span>
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste it here" />
            </label>
            <button className="btn btn-quiet" disabled={!/join\//.test(link)}>
              Open invite
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function GroupCard({ g }: { g: With<Group> }) {
  const a = g.account;
  const rounds = a.roundCount.toNumber();
  return (
    <li>
      <a className={`group-card ${a.archived ? "is-removed" : ""}`} href={`#/g/${g.publicKey.toBase58()}`}>
        <span className="banner-flag" aria-hidden>
          {a.name.trim().charAt(0).toUpperCase()}
        </span>
        <span className="group-card-main">
          <strong>{a.name}</strong>
          <span className="small muted">
            {a.memberCount} {a.memberCount === 1 ? "member" : "members"} · {rounds} {rounds === 1 ? "round" : "rounds"}
            {a.archived && " · removed"}
          </span>
        </span>
      </a>
    </li>
  );
}

const PLAYS: [string, string, string][] = [
  ["predict", "Bets", "bets"],
  ["join_group", "Group join", "joins"],
  ["create_group", "New group", "groups"],
  ["create_round", "New round", "rounds"],
];

/** Free plays from the game's bank, and topping up your own game wallet with Phantom. */
function Purse() {
  const { connection } = useConnection();
  const { me, freePlays, balance, run, busy } = useHonor();
  const now = useNow(60000);
  const [amount, setAmount] = useState(0.1);
  const selfPaying = balance !== null && balance >= SELF_PAY_LAMPORTS;
  const midnight = Math.ceil(now / 86400) * 86400;
  const hours = Math.max(1, Math.round((midnight - now) / 3600));

  return (
    <section className="purse panel" aria-labelledby="purse">
      <div className="purse-head">
        <h2 id="purse" className="section-title">
          Free plays today
        </h2>
        <span className="muted small">Resets in about {hours} h</span>
      </div>
      {selfPaying ? (
        <p>
          You're paying your own way: <strong>{(balance! / 1e9).toFixed(3)} SOL</strong> in your game wallet. Free plays kick in
          again when it runs low.
        </p>
      ) : freePlays ? (
        <ul className="plays">
          {PLAYS.map(([kind, label]) => {
            const limit = freePlays.limits[kind] ?? 0;
            const left = Math.max(0, limit - (freePlays.used[kind] ?? 0));
            return (
              <li key={kind} className={left === 0 ? "spent" : ""}>
                <strong>
                  {left}/{limit}
                </strong>
                <span>{label}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">Free plays aren't available right now.</p>
      )}
      <p className="muted small">
        Voting on results, proof and reviews are always free. Want more bets? Add SOL to your game wallet with Phantom, and you
        keep your profile and honor.
      </p>
      <div className="actions">
        <select value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount">
          {[0.1, 0.5, 1].map((v) => (
            <option key={v} value={v}>
              {v} SOL
            </option>
          ))}
        </select>
        <button
          className="btn btn-quiet"
          disabled={busy || !me}
          onClick={() => run("Waiting for Phantom…", `Added ${amount} SOL to your game wallet.`, () => topUpWithPhantom(connection, me!, amount))}
        >
          Add SOL with Phantom
        </button>
      </div>
      <p className="muted small">Test network: switch Phantom to devnet first (Settings, Developer settings, Testnet mode).</p>
    </section>
  );
}
