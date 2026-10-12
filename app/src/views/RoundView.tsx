import { useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import {
  EVIDENCE, NO_VOTE, RULES, actions, addr, duration, enumKey, fetchGroupMembers, fetchPredictions, fullName, odds, phaseOf,
  relTime, safeUrl, sha256, short, when,
  type ChallengeStatus, type EvidenceKind, type Phase, type Prediction, type Round, type With,
} from "../honor";
import { Knight } from "../Knight";
import { rankOf } from "../ranks";
import { useHonor, useLoad, useNow } from "../state";
import { PhasePill, safeKey } from "./GroupView";

const SWATCH = ["var(--violet)", "var(--gold)", "var(--plume)", "var(--steel)"];

export function RoundView({ roundKey }: { roundKey: string }) {
  const { me } = useHonor();
  const now = useNow(2000);
  const round = safeKey(roundKey);
  const { data, error } = useLoad(
    async (p) => {
      if (!round) return null;
      const r = await p.account.round.fetchNullable(round);
      if (!r) return null;
      const [g, members, preds] = await Promise.all([
        p.account.group.fetch(r.group),
        fetchGroupMembers(p, r.group),
        fetchPredictions(p, round),
      ]);
      // Has the viewer already reviewed each proof that's waiting?
      const reviewed = await p.account.proofReview.fetchMultiple(
        preds.map((x) => addr.review(x.publicKey, me!, x.account.reviewRound)),
      );
      return { r, g, members, preds, reviewed: reviewed.map((x) => !!x) };
    },
    [roundKey],
  );

  if (!round || data === null) return <p className="error pad center">Round not found.</p>;
  if (error) return <p className="error pad center">{error}</p>;
  if (!data) return <p className="muted pad center">Loading round…</p>;

  const { r, g, members, preds, reviewed } = data;
  const people = new Map(members.map((m) => [m.membership.user.toBase58(), m.profile]));
  const nameOf = (k: PublicKey) => (k.equals(me!) ? "You" : people.get(k.toBase58()) ? fullName(people.get(k.toBase58())) : short(k));
  const rankFor = (k: PublicKey) => rankOf(people.get(k.toBase58())?.honorPoints.toNumber() ?? 0).rank;
  const isMember = members.some((m) => m.membership.user.equals(me!));
  const phase = phaseOf(r, now);
  const evidence = enumKey<EvidenceKind>(r.evidence);
  const mine = preds.find((x) => x.account.user.equals(me!));

  return (
    <article className="round">
      <a className="back" href={`#/g/${r.group.toBase58()}`}>
        {g.name}
      </a>
      <header className="round-head">
        <div className="pills">
          <PhasePill phase={phase} r={r} now={now} />
          <span className={`pill pill-evidence ${evidence === "aiCheck" ? "pill-beta" : ""}`}>{EVIDENCE[evidence].label}</span>
        </div>
        <h1 className="question">{r.question}</h1>
        <p className="muted">
          Asked by {nameOf(r.creator)}, {relTime(r.createdAt.toNumber(), now)} · {r.totalVotes}{" "}
          {r.totalVotes === 1 ? "call" : "calls"}
        </p>
      </header>

      <Banner r={r} phase={phase} />

      <section className="rules panel" aria-labelledby="rules">
        <h2 id="rules" className="section-title">
          <span className="seal-icon" aria-hidden /> Locked rules
        </h2>
        <dl>
          <div>
            <dt>Challenge for the wrong side</dt>
            <dd>{r.challenge}</dd>
          </div>
          <div>
            <dt>Result decided by</dt>
            <dd>{EVIDENCE[evidence].label}</dd>
          </div>
          <div>
            <dt>Calls close</dt>
            <dd>{when(r.votesCloseAt.toNumber())}</dd>
          </div>
          <div>
            <dt>Result vote</dt>
            <dd>{duration(r.resolveWindowSecs.toNumber())} after calls close</dd>
          </div>
          <div>
            <dt>To do the challenge</dt>
            <dd>{duration(r.challengeWindowSecs.toNumber())} after the result</dd>
          </div>
        </dl>
        <p className="muted small">Written to Solana when the round started. Nobody can edit or cancel it.</p>
      </section>

      {isMember ? (
        <>
          <YourCall round={round} r={r} phase={phase} mine={mine?.account} />
          <Result round={round} r={r} phase={phase} evidence={evidence} now={now} mine={mine?.account} preds={preds} />
          {(phase === "resolved" || phase === "void") && preds.length > 0 && (
            <Challenges round={round} r={r} preds={preds} reviewed={reviewed} nameOf={nameOf} rankFor={rankFor} now={now} />
          )}
        </>
      ) : (
        <p className="note">You're not in this group, so you can watch but not play.</p>
      )}
    </article>
  );
}

// ------------------------------------------------------------------ the odds banner
function Banner({ r, phase }: { r: Round; phase: Phase }) {
  const [weighted, setWeighted] = useState(false);
  const o = odds(r);
  const resolved = phase === "resolved";
  return (
    <section className="banner-wrap" aria-label="Group odds">
      <div className="banner" role="img" aria-label={o.map((x) => `${x.label} ${Math.round((weighted ? x.weighted : x.share) * 100)}%`).join(", ")}>
        {o.map((x, i) => {
          const pct = (weighted ? x.weighted : x.share) * 100;
          const win = resolved && r.outcome === i;
          return (
            <div
              key={i}
              className={`banner-seg ${resolved && !win ? "dim" : ""} ${win ? "win" : ""}`}
              style={{ flexGrow: Math.max(pct, 0.0001), background: SWATCH[i] }}
            >
              {pct >= 12 && (
                <span className={i === 1 || i === 2 ? "on-light" : ""}>
                  {x.label} {Math.round(pct)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="banner-legend">
        <ul>
          {o.map((x, i) => (
            <li key={i}>
              <span className="swatch" style={{ background: SWATCH[i] }} aria-hidden />
              {x.label}: {x.votes} {x.votes === 1 ? "call" : "calls"}
              {resolved && r.outcome === i && <strong className="won"> ✓ result</strong>}
            </li>
          ))}
        </ul>
        <button className="link small" onClick={() => setWeighted(!weighted)}>
          {weighted ? "Show by calls" : "Weigh by how sure people are"}
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ making a prediction
function YourCall({ round, r, phase, mine }: { round: PublicKey; r: Round; phase: Phase; mine?: Prediction }) {
  const { program, me, run, busy } = useHonor();
  const [choice, setChoice] = useState<number | null>(null);
  const [conf, setConf] = useState(70);

  if (mine)
    return (
      <section className="call panel">
        <h2 className="section-title">Your call</h2>
        <p>
          You picked <strong>{r.options[mine.choice]}</strong>, {mine.confidence}% sure.
        </p>
      </section>
    );
  if (phase !== "predicting")
    return (
      <section className="call panel">
        <h2 className="section-title">Your call</h2>
        <p className="muted">Calls closed before you picked a side.</p>
      </section>
    );
  const bonus = Math.min(RULES.confidenceBonusMax, Math.floor(conf / 20));
  return (
    <section className="call panel">
      <h2 className="section-title">Make your call</h2>
      <div className="choices" role="radiogroup" aria-label="Options">
        {r.options.map((o, i) => (
          <button key={i} role="radio" aria-checked={choice === i} className={`choice ${choice === i ? "on" : ""}`} onClick={() => setChoice(i)}>
            {o}
          </button>
        ))}
      </div>
      <label className="field">
        <span>How sure are you? {conf}%</span>
        <input type="range" min={0} max={100} step={5} value={conf} onChange={(e) => setConf(Number(e.target.value))} />
      </label>
      <p className="muted small">
        Right: +{RULES.correctBase + bonus} Prediction Points. Wrong: {r.challenge}.
      </p>
      <button
        className="btn btn-gold"
        disabled={choice === null || busy}
        onClick={() => run("Locking in your call…", "Your call is locked in.", () => actions.predict(program, me!, round, r.group, choice!, conf))}
      >
        Lock in my call
      </button>
    </section>
  );
}

// ------------------------------------------------------------------ the result vote
function Result(props: {
  round: PublicKey; r: Round; phase: Phase; evidence: EvidenceKind; now: number; mine?: Prediction; preds: With<Prediction>[];
}) {
  const { round, r, phase, evidence, now, mine, preds } = props;
  const { program, me, run, busy } = useHonor();
  const unsettled = preds.filter((x) => enumKey<ChallengeStatus>(x.account.status) === "unsettled");
  const close = r.votesCloseAt.toNumber();
  const voteEnds = close + r.resolveWindowSecs.toNumber();
  const myVote = mine && mine.outcomeVote !== NO_VOTE ? mine.outcomeVote : null;
  const tally = (
    <ul className="tally">
      {r.options.map((o, i) => (
        <li key={i} className={phase === "resolved" && r.outcome === i ? "win" : ""}>
          <span>{o}</span>
          <span className="tally-bar">
            <span style={{ width: `${r.totalVotes ? (r.outcomeVotes[i] / r.totalVotes) * 100 : 0}%` }} />
          </span>
          <strong>{r.outcomeVotes[i]}</strong>
        </li>
      ))}
    </ul>
  );

  let body;
  if (phase === "predicting")
    body = (
      <p className="muted">
        Calls close {relTime(close, now)}. Then everyone who made a call votes on what really happened.
      </p>
    );
  else if (phase === "resultVote")
    body = (
      <>
        <p>
          <strong>
            {r.outcomeVoteCount} of {r.totalVotes}
          </strong>{" "}
          players have voted. The vote ends {when(voteEnds)}, or as soon as one answer has a majority.
        </p>
        {mine && myVote === null && (
          <>
            <p className="muted small">
              What actually happened? Check the facts, not your call: voting with the group's final answer earns +
              {RULES.fairPlay} Honor Points.
            </p>
            <div className="choices">
              {r.options.map((o, i) => (
                <button
                  key={i}
                  className="choice"
                  disabled={busy}
                  onClick={() => run(`Voting “${o}”…`, "Your vote is on the record.", () => actions.voteOutcome(program, me!, round, i))}
                >
                  {o}
                </button>
              ))}
            </div>
          </>
        )}
        {myVote !== null && (
          <p className="muted">
            You voted <strong>{r.options[myVote]}</strong>. Waiting for the others.
          </p>
        )}
        {!mine && <p className="muted small">Only players who made a call vote on the result.</p>}
      </>
    );
  else if (phase === "closing")
    body = (
      <>
        <p>The result vote is over. Count the votes to reveal the result. Anyone can do it.</p>
        <button className="btn btn-gold" disabled={busy} onClick={() => run("Counting the votes…", "The votes are counted.", () => actions.finalize(program, me!, round))}>
          Count the votes
        </button>
      </>
    );
  else if (phase === "resolved")
    body = (
      <>
        <p className="verdict">
          The group decided: <strong>{r.options[r.outcome]}</strong>
          <span className="muted small"> · {relTime(r.resolvedAt.toNumber(), now)}</span>
        </p>
        {tally}
        {unsettled.length > 0 && (
          <button
            className="btn btn-gold"
            disabled={busy}
            onClick={() =>
              run("Handing out points and challenges…", "Everyone's points and challenges are settled.", () =>
                actions.settleAll(program, me!, round, r, unsettled.map((x) => x.account.user)),
              )
            }
          >
            Settle points for everyone ({unsettled.length} left)
          </button>
        )}
      </>
    );
  else
    body = (
      <>
        <p>
          <strong>No result.</strong>{" "}
          {r.totalVotes < RULES.minVoters
            ? "Fewer than two people made a call."
            : r.outcomeVoteCount === 0
              ? "Nobody voted on the result."
              : "The result vote was a tie."}{" "}
          Nobody owes anything, and the round stays on the record.
        </p>
        {r.outcomeVoteCount > 0 && tally}
        {unsettled.length > 0 && (
          <button
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => run("Closing out calls…", "Done.", () => actions.settleAll(program, me!, round, r, unsettled.map((x) => x.account.user)))}
          >
            Close out {unsettled.length} {unsettled.length === 1 ? "call" : "calls"}
          </button>
        )}
      </>
    );

  return (
    <section className="result panel">
      <h2 className="section-title">The result</h2>
      {evidence === "aiCheck" && phase !== "resolved" && phase !== "void" && (
        <p className="beta-note small">
          <span className="pill pill-beta">Beta</span> AI checking is coming soon. Until then this round is decided by the group vote.
        </p>
      )}
      {body}
    </section>
  );
}

// ------------------------------------------------------------------ challenges & proof
const STATUS_TEXT: Record<ChallengeStatus, string> = {
  unsettled: "Not settled yet",
  won: "Called it",
  pending: "Owes the challenge",
  proofSubmitted: "Proof waiting for review",
  completed: "Kept their word",
  failed: "Missed the deadline",
  declined: "Declined",
  shielded: "Used a shield",
  void: "No result",
};

function Challenges(props: {
  round: PublicKey; r: Round; preds: With<Prediction>[]; reviewed: boolean[]; now: number;
  nameOf: (k: PublicKey) => string; rankFor: (k: PublicKey) => ReturnType<typeof rankOf>["rank"];
}) {
  const { me } = useHonor();
  const sorted = props.preds
    .map((p, i) => ({ ...p, reviewed: props.reviewed[i] }))
    .sort((a, b) => Number(b.account.user.equals(me!)) - Number(a.account.user.equals(me!)));
  return (
    <section className="challenges">
      <h2 className="section-title">Who owes what</h2>
      <ul className="people">
        {sorted.map((x) => (
          <Person key={x.publicKey.toBase58()} {...props} p={x.account} reviewed={x.reviewed} />
        ))}
      </ul>
    </section>
  );
}

function Person({ round, r, p, reviewed, nameOf, rankFor, now }: {
  round: PublicKey; r: Round; p: Prediction; reviewed: boolean; now: number;
  nameOf: (k: PublicKey) => string; rankFor: (k: PublicKey) => ReturnType<typeof rankOf>["rank"];
}) {
  const { program, me, profile, run, busy } = useHonor();
  const st = enumKey<ChallengeStatus>(p.status);
  const isMe = p.user.equals(me!);
  const deadline = p.challengeDeadline.toNumber();
  const late = st === "pending" && now > deadline;
  const reviewExpired = st === "proofSubmitted" && now > deadline + RULES.reviewGraceSecs;
  const attemptsLeft = RULES.maxProofAttempts - p.reviewRound;
  const rank = rankFor(p.user);
  const link = safeUrl(p.proofUri);

  return (
    <li className={`person st-${st}`}>
      <div className="person-head">
        <Knight rank={rank.id} size={44} />
        <span className="who">
          {nameOf(p.user)}
          <span className="muted small">
            {" "}
            picked {r.options[p.choice]} ({p.confidence}% sure)
          </span>
        </span>
        <span className={`status status-${st}`}>
          {STATUS_TEXT[st]}
          {st === "won" && ` +${p.pointsAwarded.toString()} pts`}
          {st === "completed" && ` +${p.pointsAwarded.toString()} honor`}
        </span>
      </div>

      {st === "pending" && (
        <p className="small">
          {r.challenge}. {late ? "The deadline passed." : `Due ${relTime(deadline, now)}.`}
          {p.reviewRound > 0 && ` Friends rejected the last proof. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left.`}
        </p>
      )}

      {isMe && st === "pending" && !late && (
        <ProofForm round={round} r={r} shields={profile?.shields ?? 0} attemptsLeft={attemptsLeft} />
      )}

      {st === "proofSubmitted" && (
        <div className="proof">
          <p className="small">
            {p.approvals} of {p.approvalsNeeded} approvals needed
            {p.rejections > 0 && `, ${p.rejections} rejected`}.
          </p>
          {link && (
            <a className="link small" href={link} target="_blank" rel="noreferrer noopener">
              Watch the proof
            </a>
          )}
          <p className="hash small" title="Fingerprint of the proof file, stored on Solana">
            Proof fingerprint {bytesToHex(p.proofHash).slice(0, 16)}…
          </p>
          {!isMe && !reviewed && <Review round={round} p={p} />}
          {!isMe && reviewed && <p className="muted small">You've reviewed this proof.</p>}
        </div>
      )}

      {(late || reviewExpired) && (
        <button
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => run("Closing the challenge…", "The challenge is closed.", () => actions.expire(program, me!, round, p))}
        >
          {late ? "Mark as missed" : "Close the review"}
        </button>
      )}
    </li>
  );
}

function ProofForm({ round, r, shields, attemptsLeft }: { round: PublicKey; r: Round; shields: number; attemptsLeft: number }) {
  const { program, me, run, busy } = useHonor();
  const [hash, setHash] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState("");
  const [uri, setUri] = useState("");
  const [declining, setDeclining] = useState(false);
  const uriOk = !uri || (/^https?:\/\//i.test(uri) && new TextEncoder().encode(uri).length <= 160);

  return (
    <div className="proof-form stack">
      {attemptsLeft > 0 ? (
        <>
          <label className="field">
            <span>Your proof video or photo</span>
            <input
              type="file"
              accept="video/*,image/*"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFileName(f.name);
                setHash(await sha256(await f.arrayBuffer()));
              }}
            />
          </label>
          <p className="muted small">
            The file never leaves your device. Only its fingerprint goes on Solana, so nobody can swap the video later.
            {fileName && hash && ` Fingerprint of ${fileName}: ${bytesToHex(hash).slice(0, 16)}…`}
          </p>
          <label className="field">
            <span>Link friends can watch (optional, unlisted is best)</span>
            <input value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://…" />
          </label>
          {!uriOk && <p className="error small">Use a full https:// link under 160 characters.</p>}
          <p className="muted small">The link is public on Solana. Don't share anything private.</p>
        </>
      ) : (
        <p className="muted small">No proof attempts left. Use a shield, decline, or the challenge is missed at the deadline.</p>
      )}
      <div className="actions">
        {attemptsLeft > 0 && (
          <button
            className="btn btn-gold"
            disabled={!hash || !uriOk || busy}
            onClick={() => run("Submitting proof…", "Proof submitted. Your friends can review it now.", () => actions.submitProof(program, me!, round, r.group, hash!, uri))}
          >
            Submit proof
          </button>
        )}
        {shields > 0 && (
          <button className="btn btn-quiet" disabled={busy} onClick={() => run("Raising a shield…", "Shield used. Your honor and streak are safe.", () => actions.useShield(program, me!, round, r.group))}>
            Use a shield ({shields} left)
          </button>
        )}
        {!declining ? (
          <button className="link small" disabled={busy} onClick={() => setDeclining(true)}>
            Decline challenge
          </button>
        ) : (
          <span className="confirm-inline small">
            Declining costs {Math.abs(RULES.challengeDeclined)} Honor Points and resets your streak.{" "}
            <button className="link small danger" disabled={busy} onClick={() => run("Declining…", "Challenge declined.", () => actions.decline(program, me!, round, r.group))}>
              Decline anyway
            </button>{" "}
            <button className="link small" onClick={() => setDeclining(false)}>
              Keep it
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function Review({ round, p }: { round: PublicKey; p: Prediction }) {
  const { program, me, run, busy } = useHonor();
  const [check, setCheck] = useState<"match" | "nomatch" | null>(null);
  return (
    <div className="review stack">
      <label className="field">
        <span>Got the file? Check it matches the fingerprint (optional)</span>
        <input
          type="file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const h = await sha256(await f.arrayBuffer());
            setCheck(bytesToHex(h) === bytesToHex(p.proofHash) ? "match" : "nomatch");
          }}
        />
      </label>
      {check === "match" && <p className="ok small">This is exactly the file that was submitted.</p>}
      {check === "nomatch" && <p className="error small">This file is different from the one that was submitted.</p>}
      <div className="actions">
        <button className="btn btn-ok" disabled={busy} onClick={() => run("Approving…", `Approved. +${RULES.fairPlay} Honor Points for fair play.`, () => actions.review(program, me!, round, p, true))}>
          Approve
        </button>
        <button className="btn btn-warn" disabled={busy} onClick={() => run("Rejecting…", `Rejected. +${RULES.fairPlay} Honor Points for fair play.`, () => actions.review(program, me!, round, p, false))}>
          Reject
        </button>
      </div>
    </div>
  );
}

function bytesToHex(b: ArrayLike<number>) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
