// App-wide state: the program client, the signed-in player, their profile, free plays from the
// hidden SOL bank, and a helper that runs a game action with a toast and refreshes the screen.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { errorMessage, fetchProfile, makeProgram, type HonorProgram, type Profile } from "./honor";
import { useLogin, type Login } from "./login";
import { fetchFreePlays, makeSponsor, type FreePlays } from "./sponsor";

type Toast = { id: number; kind: "busy" | "ok" | "error"; text: string };

type Ctx = {
  auth: Login;
  program: HonorProgram;
  me: PublicKey | null;
  profile: Profile | null | undefined; // undefined = still loading
  /** Today's free plays from the bank, or null if the bank isn't reachable. */
  freePlays: FreePlays | null;
  /** The player's own SOL balance in lamports. */
  balance: number | null;
  version: number; // bumps after every successful action, so views reload
  refresh: () => void;
  run: (label: string, done: string, fn: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  toasts: Toast[];
};

const HonorCtx = createContext<Ctx | null>(null);

export function HonorProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const auth = useLogin();
  const wallet = auth.wallet;
  const me = wallet?.publicKey ?? null;
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Free plays from the hidden SOL bank (see sponsor.ts), refreshed with everything else.
  const tokenRef = useRef(auth.getAccessToken);
  tokenRef.current = auth.getAccessToken;
  const [freePlays, setFreePlays] = useState<FreePlays | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    if (!me) return;
    tokenRef.current().then(fetchFreePlays).then((f) => live && setFreePlays(f));
    connection.getBalance(me).then((b) => live && setBalance(b), () => {});
    return () => {
      live = false;
    };
  }, [me, connection, version]);

  const bank = freePlays?.bank ?? null;
  const sponsor = useMemo(
    () => (wallet && bank ? makeSponsor(connection, wallet, new PublicKey(bank), () => tokenRef.current()) : undefined),
    [connection, wallet, bank],
  );
  const program = useMemo(() => makeProgram(connection, wallet, sponsor), [connection, wallet, sponsor]);

  // Tagged with its owner, so switching accounts never shows the previous player's profile.
  const [loaded, setLoaded] = useState<{ owner: string; profile: Profile | null } | null>(null);
  const profile = me && loaded?.owner === me.toBase58() ? loaded.profile : undefined;
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Pick up friends' moves: reload every 15 s while the tab is visible, and when you come back to it.
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && refresh();
    const t = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  useEffect(() => {
    let live = true;
    if (!me) return;
    const owner = me.toBase58();
    fetchProfile(program, me)
      .then((p) => live && setLoaded({ owner, profile: p }))
      .catch(() => live && setLoaded((l) => (l?.owner === owner ? l : { owner, profile: null })));
    return () => {
      live = false;
    };
  }, [program, me, version]);

  const toast = useCallback((t: Omit<Toast, "id">, ms = 0) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.filter((x) => x.kind !== "busy"), { ...t, id }]);
    if (ms) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ms);
  }, []);

  const run = useCallback(
    async (label: string, done: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      toast({ kind: "busy", text: label });
      try {
        await fn();
        toast({ kind: "ok", text: done }, 3500);
        refresh();
        return true;
      } catch (e) {
        console.error(e);
        toast({ kind: "error", text: errorMessage(e) }, 9000);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast, refresh],
  );

  return (
    <HonorCtx.Provider value={{ auth, program, me, profile, freePlays, balance, version, refresh, run, busy, toasts }}>
      {children}
    </HonorCtx.Provider>
  );
}

export function useHonor() {
  const c = useContext(HonorCtx);
  if (!c) throw new Error("useHonor outside provider");
  return c;
}

/**
 * Loads data with the program, reloading whenever `version` changes. Results are tagged with
 * what they were loaded for, so a page never shows data from the previous page or wallet,
 * and a failed background refresh (e.g. a rate-limited RPC) keeps what's already on screen.
 */
export function useLoad<T>(fn: (p: HonorProgram) => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null } {
  const { program, me, version } = useHonor();
  const key = JSON.stringify([me?.toBase58() ?? null, ...deps]);
  const [state, setState] = useState<{ key: string; data?: T; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    // The free public RPC rate-limits heavy reads; back off and retry before showing an error.
    const attempt = (n: number) =>
      fn(program)
        .then((d) => live && setState({ key, data: d, error: null }))
        .catch((e) => {
          if (!live) return;
          if (n < 5 && isRateLimit(e)) {
            timer = setTimeout(() => attempt(n + 1), 1500 * 2 ** n);
            return;
          }
          setState((s) => (s?.key === key && s.data !== undefined ? s : { key, error: errorMessage(e) }));
        });
    attempt(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, version, key]);
  return state?.key === key ? { data: state.data, error: state.error } : { data: undefined, error: null };
}

const isRateLimit = (e: unknown) => /429|too many requests/i.test(String((e as { message?: string })?.message ?? e));

/** Current unix time, ticking every few seconds so countdowns stay fresh. */
export function useNow(every = 5000) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** Tiny hash router: #/g/<group>, #/r/<round>, #/join/<group>/<code>, #/leaders */
export function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

export const go = (path: string) => {
  window.location.hash = path;
  window.scrollTo(0, 0);
};

// localStorage is a convenience only (remembering invite codes you created); never required.
export const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: fine */
    }
  },
};
