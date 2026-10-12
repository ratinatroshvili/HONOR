import { CLUSTER } from "./honor";
import { rankOf } from "./ranks";
import { Knight } from "./Knight";
import { HonorProvider, useHonor, useRoute } from "./state";
import { Landing } from "./views/Landing";
import { Onboarding } from "./views/Onboarding";
import { Home } from "./views/Home";
import { GroupView } from "./views/GroupView";
import { RoundView } from "./views/RoundView";
import { JoinView } from "./views/JoinView";
import { Leaderboards } from "./views/Leaderboards";

export function App() {
  return (
    <HonorProvider>
      <Shell />
    </HonorProvider>
  );
}

function Shell() {
  const { auth, me, profile, toasts } = useHonor();
  const route = useRoute();

  // Pages are keyed by route so their local state (forms, invite codes) never leaks between pages.
  let page;
  if (!auth.ready) page = <p className="muted pad center">Opening the hall…</p>;
  else if (!auth.authenticated) page = <Landing joining={route[0] === "join"} />;
  else if (!me) page = <p className="muted pad center">Setting up your account…</p>;
  else if (profile === undefined) page = <p className="muted pad center">Loading your profile…</p>;
  else if (profile === null) page = <Onboarding />;
  else if (route[0] === "g" && route[1]) page = <GroupView key={route[1]} groupKey={route[1]} />;
  else if (route[0] === "r" && route[1]) page = <RoundView key={route[1]} roundKey={route[1]} />;
  else if (route[0] === "join" && route[1] && route[2])
    page = <JoinView key={`${route[1]}/${route[2]}`} groupKey={route[1]} code={route[2]} />;
  else if (route[0] === "leaders") page = <Leaderboards />;
  else page = <Home />;

  const tab = route[0] === "leaders" ? "leaders" : "home";
  const rank = profile ? rankOf(profile.honorPoints.toNumber()).rank : null;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <img src="/honor-emblem.png" alt="" width={40} height={35} />
          <span className="wordmark">HONOR</span>
        </a>
        {profile && (
          <nav className="nav" aria-label="Main">
            <a href="#/" aria-current={tab === "home" ? "page" : undefined}>
              My hall
            </a>
            <a href="#/leaders" aria-current={tab === "leaders" ? "page" : undefined}>
              Leaderboards
            </a>
          </nav>
        )}
        <div className="topbar-right">
          {profile && rank && (
            <span className="scores">
              <span className={`score rank-chip rank-${rank.id}`} title={`Rank: ${rank.name}`}>
                <Knight rank={rank.id} size={26} />
                <span className="hide-sm">{rank.name}</span>
              </span>
              <span className="score score-honor" title="Honor Points: keeping your word">
                <span className="gem" aria-hidden /> {profile.honorPoints.toString()}
                <span className="sr-only"> Honor Points</span>
              </span>
              <span className="score score-pp" title="Prediction Points: being right">
                <span className="coin" aria-hidden /> {profile.predictionPoints.toString()}
                <span className="sr-only"> Prediction Points</span>
              </span>
            </span>
          )}
          {auth.authenticated && (
            <button className="btn btn-quiet btn-sm" onClick={() => auth.logout()}>
              Sign out
            </button>
          )}
        </div>
      </header>
      <main className="main">{page}</main>
      <footer className="foot">
        <span>Running on Solana {CLUSTER}. No money is ever at stake: points can't be bought, sold or sent.</span>
      </footer>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "busy" && <span className="spinner" aria-hidden />}
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
