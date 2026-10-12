// Google login through Privy. Privy gives every player a Solana wallet behind their Google
// account; this file turns it into the wallet shape the Anchor client expects, signing silently.
import { useMemo, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
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

export function useLogin(): Login {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signTransaction } = useSignTransaction();
  // Only the wallet Privy created for this player (Google is the only login, so it's the only one).
  const privyWallet = authenticated ? wallets.find((w) => w.standardWallet.name === "Privy") ?? wallets[0] : undefined;
  const address = privyWallet?.address;
  // Always sign with the latest wallet object, while keeping the AnchorWallet stable per address.
  const latest = useRef(privyWallet);
  latest.current = privyWallet;

  const wallet = useMemo<AnchorWallet | undefined>(() => {
    if (!address) return undefined;
    const sign = async <T extends AnyTx>(tx: T): Promise<T> => {
      const bytes =
        tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const { signedTransaction } = await signTransaction({
        transaction: bytes,
        wallet: latest.current!,
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
  }, [address, signTransaction]);

  return {
    ready: ready && (!authenticated || walletsReady),
    authenticated,
    wallet,
    googleName: user?.google?.name ?? null,
    login,
    logout,
    getAccessToken,
  };
}
