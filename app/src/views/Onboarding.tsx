import { useState } from "react";
import { actions } from "../honor";
import { Knight } from "../Knight";
import { useHonor } from "../state";

const fits = (s: string) => s.trim().length > 0 && new TextEncoder().encode(s.trim()).length <= 32;

export function Onboarding() {
  const { auth, program, me, run, busy } = useHonor();
  // Prefill from the Google account; players can still edit both names.
  const [googleFirst, ...googleRest] = (auth.googleName ?? "").trim().split(/\s+/);
  const [first, setFirst] = useState(googleFirst ?? "");
  const [last, setLast] = useState(googleRest.join(" "));
  const valid = fits(first) && fits(last);

  return (
    <section className="onboard panel">
      <Knight rank="squire" size={140} />
      <h1 className="title">Take your oath</h1>
      <p className="lede">
        Every member of the order is known by name. Your first and last name appear on leaderboards and in your groups,
        and your record follows you everywhere.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            run("Writing your name into the order…", `Welcome, Squire ${first.trim()}.`, () =>
              actions.createProfile(program, me!, first.trim(), last.trim()),
            );
        }}
      >
        <div className="grid2">
          <label className="field">
            <span>First name</span>
            <input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={32} placeholder="Rati" autoFocus required />
          </label>
          <label className="field">
            <span>Last name</span>
            <input value={last} onChange={(e) => setLast(e.target.value)} maxLength={32} placeholder="Beridze" required />
          </label>
        </div>
        <button className="btn btn-gold" disabled={!valid || busy}>
          Swear in as a Squire
        </button>
        <p className="muted small">
          Both names are required. They're public on the leaderboards.
        </p>
      </form>
    </section>
  );
}
