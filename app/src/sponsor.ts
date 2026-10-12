// The hidden SOL bank, app side. Players with enough SOL of their own pay their own way. Everyone
// else gets free plays: the action is signed by the player and sent to the bank function
// (netlify/functions/sponsor.mjs), which pays its exact cost and counts it against today's limits.
import { AnchorProvider } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction,
  type ConfirmOptions, type Signer,
} from "@solana/web3.js";
import idl from "./idl/honor.json";
import rules from "./sponsor-rules.json";

/** Players holding at least this much (0.01 SOL) pay for themselves; below it the bank steps in. */
export const SELF_PAY_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
export const DAILY_LIMITS = rules.dailyLimits as Record<string, number>;
const ENDPOINT = "/.netlify/functions/sponsor";

export type FreePlays = { bank: string; used: Record<string, number>; limits: Record<string, number> };
export type Sponsor = (tx: Transaction) => Promise<string>;
type ProviderWallet = ConstructorParameters<typeof AnchorProvider>[1];

/** Thrown when today's free plays for an action are used up. */
export class LimitReached extends Error {}

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const KIND_BY_DISC = Object.fromEntries(idl.instructions.map((ix) => [hex(ix.discriminator), ix.name]));
const SIZES = rules.createdAccountSizes as Record<string, number[]>;

export async function fetchFreePlays(token: string | null): Promise<FreePlays | null> {
  try {
    const res = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? ((await res.json()) as FreePlays) : null;
  } catch {
    return null; // no bank available (e.g. plain local dev): players pay their own way
  }
}

/** Sends a game transaction through the bank: the bank pays the fee and the exact rent it needs. */
export function makeSponsor(connection: Connection, wallet: AnchorWallet, bank: PublicKey, getToken: () => Promise<string | null>): Sponsor {
  const rentCache = new Map<number, number>();
  const rentFor = async (size: number) => {
    if (!rentCache.has(size)) rentCache.set(size, await connection.getMinimumBalanceForRentExemption(size));
    return rentCache.get(size)!;
  };
  return async (original) => {
    let rent = 0;
    for (const ix of original.instructions)
      for (const size of SIZES[KIND_BY_DISC[hex(ix.data.subarray(0, 8))]] ?? []) rent += await rentFor(size);

    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: bank, toPubkey: wallet.publicKey, lamports: rent }),
      ...original.instructions,
    );
    tx.feePayer = bank;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const signed = await wallet.signTransaction(tx);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ transaction: signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }),
    });
    const body = (await res.json().catch(() => ({}))) as { signature?: string; error?: string; limitReached?: boolean };
    if (res.status === 402 || body.limitReached) throw new LimitReached(body.error ?? "You've used today's free plays.");
    if (!res.ok || !body.signature) throw new Error(body.error ?? "The game's bank couldn't send that. Try again.");
    return body.signature;
  };
}

/** Anchor provider that hands transactions to the bank when the player can't pay for them. */
export class GameProvider extends AnchorProvider {
  constructor(connection: Connection, wallet: ProviderWallet, opts: ConfirmOptions, private sponsor?: Sponsor) {
    super(connection, wallet, opts);
  }

  async sendAndConfirm(tx: Transaction | VersionedTransaction, signers?: Signer[], opts?: ConfirmOptions): Promise<string> {
    if (this.sponsor && tx instanceof Transaction && !signers?.length) {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      if (balance < SELF_PAY_LAMPORTS) return this.sponsor(tx);
    }
    return super.sendAndConfirm(tx, signers, opts);
  }
}

type PhantomProvider = {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString(): string } }>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
};

/** Phantom sends SOL into the player's game wallet, so they keep their profile and play past the free limits. */
export async function topUpWithPhantom(connection: Connection, to: PublicKey, sol: number) {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const phantom = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined);
  if (!phantom) {
    window.open("https://phantom.com/download", "_blank", "noopener");
    throw new Error("Install Phantom, switch it to devnet, then try again.");
  }
  const from = new PublicKey((await phantom.connect()).publicKey.toString());
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  tx.feePayer = from;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  // Sign in Phantom, but send to the game's network ourselves.
  const signed = await phantom.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");
}
