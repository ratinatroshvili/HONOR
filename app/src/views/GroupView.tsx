import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  EVIDENCE, RULES, actions, addr, enumKey, fetchGroupMembers, fetchRounds, fullName, phaseOf, randomInviteCode, relTime, when,
  type ChallengeStatus, type EvidenceKind, type Phase, type Round,
} from "../honor";
import { Knight } from "../Knight";
import { rankOf } from "../ranks";
import { go, store, useHonor, useLoad, useNow } from "../state";

export function GroupView({ groupKey }: { groupKey: string }) {
  const { me } = useHonor();
  const now = useNow();
  const [tab, setTab] = useState<"rounds" | "board">("rounds");
  const group = safeKey(groupKey);
  const { data, error } = useLoad(
    async (p) => {
      if (!group) return null;
      const g = await p.account.group.fetchNullable(group);
      if (!g) return null;
      const [members, rounds] = await Promise.all([fetchGroupMembers(p, group), fetchRounds(p, group)]);
      const mine = await p.account.prediction.fetchMultiple(rounds.map((r) => addr.prediction(r.publicKey, me!)));
      return { g, members, rounds, mine };
    },
    [groupKey],
  );

  if (!group || data === null) return <p className="error pad center">Group not found.</p>;
  if (error) return <p className="error pad center">{error}</p>;
  if (!data) return <p className="muted pad center">Loading group…</p>;
  const { g, members, rounds, mine } = data;
  const isMember = members.some((m) => m.membership.user.equals(me!));
  if (!isMember) return <p className="pad center">You're not in {g.name}. Ask a member for the invite link.</p>;
  const isAdmin = g.admin.equals(me!);

  return (
    <div className="group">
      <a className="back" href="#/">
        My hall
      </a>
      <header className="group-head">
        <span className="banner-flag big" aria-hidden>
          {g.name.trim().charAt(0).toUpperCase()}
        </span>
        <div>
          <h1 className="title">{g.name}</h1>
          <p className="muted">
            {g.memberCount} {g.memberCount === 1 ? "member" : "members"} · {rounds.length} {rounds.length === 1 ? "round" : "rounds"}
          </p>
        </div>
      </header>

      {g.archived ? (
        <p className="note">
          This group was removed {relTime(g.archivedAt.toNumber(), now)}. Nobody can join or start rounds, but every round,
          call and point stays on the record.
        </p>
      ) : (
        isAdmin && <Invite group={group} />
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "rounds"} onClick={() => setTab("rounds")}>
          Rounds
        </button>
        <button role="tab" aria-selected={tab === "board"} onClick={() => setTab("board")}>
          Leaderboard
        </button>
      </div>

      {tab === "rounds" ? (
        <>
          {!g.archived && <NewRound group={group} memberCount={g.memberCount} />}
          {rounds.length === 0 ? (
            <p className="empty">No rounds yet.{!g.archived && " Ask the first question above."}</p>
          ) : (
            <ul className="round-list">
              {rounds.map((r, i) => {
                const my = mine[i];
                const phase = phaseOf(r.account, now);
                return (
                  <li key={r.publicKey.toBase58()}>
                    <a className={`round-card phase-${phase}`} href={`#/r/${r.publicKey.toBase58()}`}>
                      <span className="round-card-q">{r.account.question}</span>
                      <span className="round-card-meta">
                        <PhasePill phase={phase} r={r.account} now={now} />
                        <span className="small muted">
                          {my ? myLine(enumKey<ChallengeStatus>(my.status), r.account.options[my.choice], r.account.challenge) : "You haven't made a call"}
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <GroupBoard members={members} />
      )}

      {isAdmin && !g.archived && <RemoveGroup group={group} name={g.name} />}
    </div>
  );
}

function myLine(st: ChallengeStatus, pick: string, challenge: string) {
  switch (st) {
    case "pending":
      return `You owe: ${challenge}`;
    case "proofSubmitted":
      return "Your proof is being reviewed";
    case "completed":
      return "You did the challenge";
    case "failed":
      return "You missed the challenge";
    case "won":
      return `You called it: ${pick}`;
    default:
      return `You picked ${pick}`;
  }
}

export function PhasePill({ phase, r, now }: { phase: Phase; r: Round; now: number }) {
  const close = r.votesCloseAt.toNumber();
  const label = {
    predicting: `Calls close ${relTime(close, now)}`,
    resultVote: `Result vote ends ${relTime(close + r.resolveWindowSecs.toNumber(), now)}`,
    closing: "Result vote finished",
    resolved: "Settled",
    void: "No result",
  }[phase];
  return <span className={`pill pill-${phase}`}>{label}</span>;
}

function GroupBoard({ members }: { members: Awaited<ReturnType<typeof fetchGroupMembers>> }) {
  const { me } = useHonor();
  const [by, setBy] = useState<"honor" | "predictions">("honor");
  const val = (m: (typeof members)[number]) =>
    by === "honor" ? m.membership.honorPoints.toNumber() : m.membership.predictionPoints.toNumber();
  const sorted = members.slice().sort((a, b) => val(b) - val(a));
  return (
    <>
      <div className="seg" role="group" aria-label="Rank by">
        <button aria-pressed={by === "honor"} onClick={() => setBy("honor")}>
          Honor
        </button>
        <button aria-pressed={by === "predictions"} onClick={() => setBy("predictions")}>
          Prediction points
        </button>
      </div>
      <p className="muted small">Points earned inside this group.</p>
      <ol className="board">
        {sorted.map((m, i) => {
          const r = rankOf(m.profile?.honorPoints.toNumber() ?? 0).rank;
          const isMe = m.membership.user.equals(me!);
          return (
            <li key={m.membership.user.toBase58()} className={isMe ? "me" : ""}>
              <span className="place">{i + 1}</span>
              <Knight rank={r.id} size={40} />
              <span className="who">
                {fullName(m.profile)}
                {isMe && <span className="muted small"> (you)</span>}
              </span>
              <span className={`rank-tag rank-${r.id}`}>{r.name}</span>
              <span className="pts">
                {val(m)} <span className="muted small">{by === "honor" ? "honor" : "pts"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Invite({ group }: { group: PublicKey }) {
  const { program, me, run, busy } = useHonor();
  const [code, setCode] = useState(() => store.get(`invite:${group.toBase58()}`));
  const [copied, setCopied] = useState(false);
  const link = code ? `${window.location.origin}${window.location.pathname}#/join/${group.toBase58()}/${code}` : null;

  if (!link)
    return (
      <div className="invite panel">
        <p className="muted small">The invite link was made on another device.</p>
        <button
          className="btn btn-quiet"
          disabled={busy}
          onClick={async () => {
            const c = randomInviteCode();
            const ok = await run("Making a new invite link…", "New invite link ready. Old links stop working.", () =>
              actions.rotateInvite(program, me!, group, c),
            );
            if (ok) {
              store.set(`invite:${group.toBase58()}`, c);
              setCode(c);
            }
          }}
        >
          Make a new invite link
        </button>
      </div>
    );
  return (
    <div className="invite panel">
      <label className="field grow">
        <span>Invite link (anyone with it can join)</span>
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
      </label>
      <button
        className="btn btn-quiet"
        onClick={() => {
          navigator.clipboard?.writeText(link).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

function RemoveGroup({ group, name }: { group: PublicKey; name: string }) {
  const { program, me, run, busy } = useHonor();
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="danger-zone">
      {!confirming ? (
        <button className="link small danger" onClick={() => setConfirming(true)}>
          Remove this group
        </button>
      ) : (
        <div className="panel stack">
          <p>
            <strong>Remove {name}?</strong> Nobody will be able to join or start new rounds. Rounds already running still
            play out, and every round, call and point stays on the record forever. This can't be undone.
          </p>
          <div className="actions">
            <button
              className="btn btn-warn"
              disabled={busy}
              onClick={() => run("Removing group…", `${name} was removed. Its record stays.`, () => actions.archiveGroup(program, me!, group))}
            >
              Remove group
            </button>
            <button className="btn btn-quiet" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const CHALLENGES = ["30 push-ups", "Buy snacks for the group", "Sing the chorus of a song", "Wear a silly hat for a day", "50 squats"];
const RESOLVE_WINDOW = [
  [60, "1 minute (demo)"],
  [3600, "1 hour"],
  [86400, "1 day"],
] as const;
const CHALLENGE_WINDOW = [
  [3600, "1 hour"],
  [86400, "1 day"],
  [3 * 86400, "3 days"],
  [7 * 86400, "1 week"],
] as const;

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function NewRound({ group, memberCount }: { group: PublicKey; memberCount: number }) {
  const { program, me, run, busy } = useHonor();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["Yes", "No"]);
  const [challenge, setChallenge] = useState(CHALLENGES[0]);
  const [evidence, setEvidence] = useState<EvidenceKind>("groupVote");
  const [closeAt, setCloseAt] = useState(() => toLocalInput(new Date(Date.now() + 86400_000)));
  const [resolveSecs, setResolveSecs] = useState(3600);
  const [challengeSecs, setChallengeSecs] = useState(86400);

  if (memberCount < RULES.minVoters)
    return <p className="note">Invite at least one friend with the link above before starting a round.</p>;

  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const closeUnix = Math.floor(new Date(closeAt).getTime() / 1000);
  const problems = [
    !question.trim() && "Write a question.",
    bytes(question) > 140 && "Keep the question under 140 characters.",
    options.some((o) => !o.trim() || bytes(o) > 32) && "Each option needs 1 to 32 characters.",
    (!challenge.trim() || bytes(challenge) > 100) && "Describe the challenge in up to 100 characters.",
    !(closeUnix > Date.now() / 1000 + 30) && "Calls must close in the future.",
  ].filter(Boolean) as string[];

  if (!open)
    return (
      <button className="btn btn-gold new-round" onClick={() => setOpen(true)}>
        Ask a new question
      </button>
    );

  return (
    <form
      className="panel stack new-round-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (problems.length) return;
        let round: PublicKey | null = null;
        const ok = await run("Locking the rules on Solana…", "Round started. Make your call.", async () => {
          round = await actions.createRound(program, me!, group, {
            question: question.trim(),
            options: options.map((o) => o.trim()),
            challenge: challenge.trim(),
            evidence,
            closeAt: closeUnix,
            resolveSecs,
            challengeSecs,
          });
        });
        if (ok && round) go(`/r/${(round as PublicKey).toBase58()}`);
      }}
    >
      <h2 className="section-title">New round</h2>
      <label className="field">
        <span>Question</span>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Will we finish the project by Friday?" autoFocus />
      </label>
      <fieldset className="field">
        <legend>Options</legend>
        <div className="options-edit">
          {options.map((o, i) => (
            <span key={i} className="opt-edit">
              <input
                aria-label={`Option ${i + 1}`}
                value={o}
                maxLength={32}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 && (
                <button type="button" className="link small" onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </span>
          ))}
          {options.length < 4 && (
            <button type="button" className="link small" onClick={() => setOptions([...options, ""])}>
              + Add option
            </button>
          )}
        </div>
      </fieldset>
      <label className="field">
        <span>Challenge for the wrong side</span>
        <input value={challenge} onChange={(e) => setChallenge(e.target.value)} maxLength={100} />
      </label>
      <div className="chips" aria-label="Challenge ideas">
        {CHALLENGES.map((c) => (
          <button type="button" key={c} className={`chip ${c === challenge ? "on" : ""}`} onClick={() => setChallenge(c)}>
            {c}
          </button>
        ))}
      </div>
      <p className="muted small">Keep it safe and voluntary. Anyone can decline a challenge, but it costs honor.</p>

      <label className="field">
        <span>How the result is decided</span>
        <select value={evidence} onChange={(e) => setEvidence(e.target.value as EvidenceKind)}>
          {(Object.keys(EVIDENCE) as EvidenceKind[]).map((k) => (
            <option key={k} value={k}>
              {EVIDENCE[k].label}
            </option>
          ))}
        </select>
      </label>
      <p className={`muted small ${evidence === "aiCheck" ? "beta-note" : ""}`}>{EVIDENCE[evidence].help}</p>

      <div className="grid3">
        <label className="field">
          <span>Calls close</span>
          <input type="datetime-local" value={closeAt} onChange={(e) => setCloseAt(e.target.value)} />
        </label>
        <label className="field">
          <span>Result vote lasts</span>
          <select value={resolveSecs} onChange={(e) => setResolveSecs(Number(e.target.value))}>
            {RESOLVE_WINDOW.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Time to do the challenge</span>
          <select value={challengeSecs} onChange={(e) => setChallengeSecs(Number(e.target.value))}>
            {CHALLENGE_WINDOW.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {Number.isFinite(closeUnix) && (
        <p className="muted small">
          Calls close {when(closeUnix)}. Then everyone who made a call votes on the result.
        </p>
      )}
      {problems.length > 0 && question && <p className="error small">{problems[0]}</p>}
      <div className="actions">
        <button className="btn btn-gold" disabled={busy || problems.length > 0}>
          Lock the rules and start
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
          Not now
        </button>
      </div>
      <p className="muted small">Once a round starts it can't be edited or cancelled. It plays out and stays on record.</p>
    </form>
  );
}

export function safeKey(k: string): PublicKey | null {
  try {
    return new PublicKey(k);
  } catch {
    return null;
  }
}
