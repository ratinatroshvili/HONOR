import { Knight } from "../Knight";
import { RANKS } from "../ranks";
import { useHonor } from "../state";

const STEPS = [
  ["Ask the question", "“Will we finish the project by Friday?” Pick the options and the challenge the wrong side owes."],
  ["Make your call", "Everyone picks a side and says how sure they are. The odds banner fills in as calls come in."],
  ["The rules lock", "Deadline, evidence and challenge are written to Solana. Nobody can edit or cancel a round."],
  ["The group votes", "When calls close, everyone who played votes on what really happened. The majority decides."],
  ["Pay what you owe", "The wrong side does the challenge and uploads proof. Friends approve it. Honor goes up."],
];

export function Landing({ joining }: { joining: boolean }) {
  const { auth } = useHonor();
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">A prediction game for friend groups</p>
          <h1 className="display">
            Make the call.
            <br />
            <span className="gold-text">Keep your word.</span>
          </h1>
          <p className="lede">
            Guess how things turn out. Wrong? You owe the challenge your group agreed on, and your friends confirm you did
            it. No money, ever: just honor, ranks and a record nobody can erase.
          </p>
          {joining && <p className="note">Sign in to accept your invite.</p>}
          <div className="hero-cta">
            <button className="btn btn-gold btn-google" disabled={!auth.ready} onClick={() => auth.login()}>
              <GoogleMark />
              {joining ? "Continue with Google to join" : "Continue with Google"}
            </button>
          </div>
        </div>
        <div className="hero-art" aria-hidden>
          <div className="hero-glow" />
          <Knight rank="grandmaster" size={300} />
        </div>
      </section>

      <section className="ladder-wrap" aria-labelledby="ranks">
        <h2 id="ranks" className="section-title center">Rise through the order</h2>
        <p className="muted center">Your rank comes from Honor Points: complete challenges to climb, dodge them and fall.</p>
        <ol className="ladder">
          {RANKS.map((r) => (
            <li key={r.id} className={`ladder-step rank-${r.id}`}>
              <Knight rank={r.id} size={92} />
              <strong>{r.name}</strong>
              <span className="small muted">{r.id === "fuflo" ? "below 0" : `${r.min}+ honor`}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="steps" aria-labelledby="how">
        <h2 id="how" className="section-title center">How a round works</h2>
        <ol>
          {STEPS.map(([t, d], i) => (
            <li key={t}>
              <span className="step-num">{i + 1}</span>
              <h3>{t}</h3>
              <p>{d}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}
