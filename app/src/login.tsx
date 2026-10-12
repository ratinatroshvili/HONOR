// Google login through Privy. Privy gives every player a Solana wallet behind their Google
// account; this file turns it into the wallet shape the Anchor client expects, signing silently.
//
// Speed: the player's address comes straight from their Privy account, so their profile and
// groups load immediately. Privy's signing wallet loads in the background and is only awaited
// when an action actually needs a signature.
import { useMemo, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets, type ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { CLUSTER } from "./honor";

export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string) || "";
const CHAIN = CLUSTER === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";

type AnyTx = Transaction | VersionedTransaction;

export type Login = {
  /** Privy has loaded and knows whether someone is logged in. */
  ready: boolean;
  authenticated: boolean;
  wallet: AnchorWallet | undefined;
  /** Google name, to prefill the profile form. */
  googleName: string | null;
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
};

/** True when this browser has a Privy session, so we can show "loading" instead of the landing page. */
export function hasSavedSession() {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith("privy:") && k.includes("token"));
  } catch {
    return false;
  }
}

export function useLogin(): Login {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();

  // The address is on the player's Privy account as soon as they're signed in.
  const linked = user?.linkedAccounts.find(
    (a) => a.type === "wallet" && a.chainType === "solana" && (a.walletClientType === "privy" || a.connectorType === "embedded"),
  );
  const signer = authenticated ? wallets.find((w) => w.standardWallet.name === "Privy") ?? wallets[0] : undefined;
  const address = authenticated ? (linked && "address" in linked ? linked.address : signer?.address) : undefined;

  // Always sign with the latest signing wallet and function, while keeping the AnchorWallet stable
  // per address. Privy may hand out new copies of both on every render; if the wallet changed with
  // them, every page load would restart before it could finish.
  const latest = useRef<ConnectedStandardSolanaWallet | undefined>(signer);
  latest.current = signer;
  const signRef = useRef(signTransaction);
  signRef.current = signTransaction;

  const wallet = useMemo<AnchorWallet | undefined>(() => {
    if (!address) return undefined;
    const waitForSigner = async () => {
      for (let i = 0; i < 150 && !latest.current; i++) await new Promise((r) => setTimeout(r, 100));
      if (!latest.current) throw new Error("Your account is still loading. Try again in a moment.");
      return latest.current;
    };
    const sign = async <T extends AnyTx>(tx: T): Promise<T> => {
      const bytes =
        tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const { signedTransaction } = await signRef.current({
        transaction: bytes,
        wallet: await waitForSigner(),
        chain: CHAIN,
        options: { uiOptions: { showWalletUIs: false } },
      });
      return (tx instanceof VersionedTransaction ? VersionedTransaction.deserialize(signedTransaction) : Transaction.from(signedTransaction)) as T;
    };
    return {
      publicKey: new PublicKey(address),
      signTransaction: sign,
      signAllTransactions: async <T extends AnyTx>(txs: T[]) => {
        const out: T[] = [];
        for (const tx of txs) out.push(await sign(tx));
        return out;
      },
    };
  }, [address]);

  return {
    ready,
    authenticated,
    wallet,
    googleName: user?.google?.name ?? null,
    login,
    logout,
    getAccessToken,
  };
}
