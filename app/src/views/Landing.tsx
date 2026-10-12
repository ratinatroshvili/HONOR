import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Knight } from "../Knight";
import { RANKS } from "../ranks";

const STEPS = [
  ["Ask the question", "“Will we finish the project by Friday?” Pick the options and the challenge the wrong side owes."],
  ["Make your call", "Everyone picks a side and says how sure they are. The odds banner fills in as calls come in."],
  ["The rules lock", "Deadline, evidence and challenge are written to Solana. Nobody can edit or cancel a round."],
  ["The group votes", "When calls close, everyone who played votes on what really happened. The majority decides."],
  ["Pay what you owe", "The wrong side does the challenge and uploads proof. Friends approve it. Honor goes up."],
];

export function Landing({ joining }: { joining: boolean }) {
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
          {joining && <p className="note">Connect a wallet to accept your invite.</p>}
          <div className="hero-cta">
            <WalletMultiButton>{joining ? "Connect to join" : "Enter the hall"}</WalletMultiButton>
          </div>
          <p className="muted small">No wallet? Pick “Demo Wallet” to try it instantly on the test network.</p>
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
