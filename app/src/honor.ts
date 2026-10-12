// Everything the app needs to talk to the HONOR program: addresses, reads, and actions.
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import idl from "./idl/honor.json";
import type { Honor } from "./idl/honor-types";
import { HIDDEN_PLAYERS } from "./hidden";
import { GameProvider, type Sponsor } from "./sponsor";

export const PROGRAM_ID = new PublicKey(idl.address);
export const CLUSTER = (import.meta.env.VITE_CLUSTER as string) || "devnet";
export const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string) ||
  (CLUSTER === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com");

// Mirrors of the on-chain rules (programs/honor/src/lib.rs), for display only.
export const RULES = {
  correctBase: 10,
  confidenceBonusMax: 5,
  challengeCompleted: 15,
  fairPlay: 2,
  challengeFailed: -20,
  challengeDeclined: -10,
  shieldCost: 50,
  minVoters: 2,
  maxProofAttempts: 3,
  reviewGraceSecs: 2 * 24 * 60 * 60,
};

export type HonorProgram = Program<Honor>;

export function makeProgram(connection: Connection, wallet: AnchorWallet | undefined, sponsor?: Sponsor, bankError?: string): HonorProgram {
  const w =
    wallet ??
    ({
      publicKey: PublicKey.default,
      signTransaction: async () => {
        throw new Error("Connect a wallet first");
      },
      signAllTransactions: async () => {
        throw new Error("Connect a wallet first");
      },
    } as AnchorWallet);
  const provider = new GameProvider(connection, w, { commitment: "confirmed" }, wallet ? sponsor : undefined, bankError);
  return new Program<Honor>(idl as Honor, provider);
}

// ---------------------------------------------------------------- addresses (PDAs)
const u64 = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const addr = {
  profile: (user: PublicKey) => pda(Buffer.from("profile"), user.toBuffer()),
  group: (admin: PublicKey, id: number | BN) => pda(Buffer.from("group"), admin.toBuffer(), u64(id)),
  member: (group: PublicKey, user: PublicKey) => pda(Buffer.from("member"), group.toBuffer(), user.toBuffer()),
  round: (group: PublicKey, id: number | BN) => pda(Buffer.from("round"), group.toBuffer(), u64(id)),
  prediction: (round: PublicKey, user: PublicKey) => pda(Buffer.from("prediction"), round.toBuffer(), user.toBuffer()),
  review: (prediction: PublicKey, reviewer: PublicKey, reviewRound: number) =>
    pda(Buffer.from("review"), prediction.toBuffer(), reviewer.toBuffer(), Buffer.from([reviewRound])),
};

// ---------------------------------------------------------------- account types
export type Profile = Awaited<ReturnType<HonorProgram["account"]["profile"]["fetch"]>>;
export type Group = Awaited<ReturnType<HonorProgram["account"]["group"]["fetch"]>>;
export type Membership = Awaited<ReturnType<HonorProgram["account"]["membership"]["fetch"]>>;
export type Round = Awaited<ReturnType<HonorProgram["account"]["round"]["fetch"]>>;
export type Prediction = Awaited<ReturnType<HonorProgram["account"]["prediction"]["fetch"]>>;
export type ProofReview = Awaited<ReturnType<HonorProgram["account"]["proofReview"]["fetch"]>>;
export type With<T> = { publicKey: PublicKey; account: T };

export type RoundStatus = "open" | "resolved" | "void";
export type EvidenceKind = "groupVote" | "aiCheck";
export type ChallengeStatus =
  | "unsettled" | "won" | "pending" | "proofSubmitted" | "completed" | "failed" | "declined" | "shielded" | "void";

export const enumKey = <T extends string>(e: object): T => Object.keys(e)[0] as T;
export const NO_VOTE = 255;

export const EVIDENCE: Record<EvidenceKind, { label: string; help: string }> = {
  groupVote: {
    label: "Group vote",
    help: "When predictions close, everyone who made a call votes on what really happened. The majority decides.",
  },
  aiCheck: {
    label: "AI check (beta)",
    help: "An AI will check the evidence. It's in beta: until it's live, these rounds are settled by the group vote.",
  },
};

export const fullName = (p: Pick<Profile, "firstName" | "lastName"> | null | undefined) =>
  p ? `${p.firstName} ${p.lastName}` : "Unknown";

/** Where a round is in its life: predictions, then the result vote, then the end. */
export type Phase = "predicting" | "resultVote" | "closing" | "resolved" | "void";
export function phaseOf(r: Round, now: number): Phase {
  const st = enumKey<RoundStatus>(r.status);
  if (st === "resolved") return "resolved";
  if (st === "void") return "void";
  const close = r.votesCloseAt.toNumber();
  if (now < close) return "predicting";
  const everyoneVoted = r.totalVotes > 0 && r.outcomeVoteCount === r.totalVotes;
  if (now < close + r.resolveWindowSecs.toNumber() && !everyoneVoted) return "resultVote";
  return "closing";
}

// ---------------------------------------------------------------- reads
const memcmp = (offset: number, key: PublicKey) => ({ memcmp: { offset, bytes: key.toBase58() } });

export async function fetchProfile(p: HonorProgram, user: PublicKey) {
  return p.account.profile.fetchNullable(addr.profile(user));
}

/** Every player for the global leaderboards, minus the ones hidden in hidden.ts. */
export async function fetchAllProfiles(p: HonorProgram): Promise<With<Profile>[]> {
  const all = await p.account.profile.all();
  return all.filter((x) => !HIDDEN_PLAYERS.has(x.account.authority.toBase58()));
}

/** Groups the user belongs to, newest first. */
export async function fetchMyGroups(p: HonorProgram, user: PublicKey): Promise<With<Group>[]> {
  const memberships = await p.account.membership.all([memcmp(40, user)]);
  const keys = memberships.map((m) => m.account.group);
  if (!keys.length) return [];
  const groups = await p.account.group.fetchMultiple(keys);
  return groups
    .map((g, i) => (g ? { publicKey: keys[i], account: g } : null))
    .filter((x): x is With<Group> => !!x)
    .sort((a, b) => b.account.createdAt.toNumber() - a.account.createdAt.toNumber());
}

export async function fetchGroupMembers(p: HonorProgram, group: PublicKey) {
  const memberships = await p.account.membership.all([memcmp(8, group)]);
  const profiles = await p.account.profile.fetchMultiple(memberships.map((m) => addr.profile(m.account.user)));
  return memberships.map((m, i) => ({ membership: m.account, profile: profiles[i] as Profile | null }));
}

export async function fetchRounds(p: HonorProgram, group: PublicKey): Promise<With<Round>[]> {
  const rounds = await p.account.round.all([memcmp(8, group)]);
  return rounds.sort((a, b) => b.account.roundId.toNumber() - a.account.roundId.toNumber());
}

export async function fetchPredictions(p: HonorProgram, round: PublicKey): Promise<With<Prediction>[]> {
  return p.account.prediction.all([memcmp(8, round)]);
}

// ---------------------------------------------------------------- actions
async function sendIxs(p: HonorProgram, ixs: TransactionInstruction[]) {
  const provider = p.provider as AnchorProvider;
  return provider.sendAndConfirm(new Transaction().add(...ixs));
}

export async function sha256(data: ArrayBuffer | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function randomInviteCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export const actions = {
  createProfile: (p: HonorProgram, me: PublicKey, first: string, last: string) =>
    p.methods.createProfile(first, last).accountsPartial({ profile: addr.profile(me), authority: me }).rpc(),

  buyShield: (p: HonorProgram, me: PublicKey) =>
    p.methods.buyShield().accountsPartial({ profile: addr.profile(me), authority: me }).rpc(),

  async createGroup(p: HonorProgram, me: PublicKey, name: string, inviteCode: string) {
    const profile = await p.account.profile.fetch(addr.profile(me));
    const group = addr.group(me, profile.groupsCreated);
    const hash = await sha256(inviteCode);
    await p.methods
      .createGroup(name, Array.from(hash))
      .accountsPartial({ profile: addr.profile(me), group, membership: addr.member(group, me), admin: me })
      .rpc();
    return group;
  },

  rotateInvite: async (p: HonorProgram, me: PublicKey, group: PublicKey, inviteCode: string) =>
    p.methods.rotateInvite(Array.from(await sha256(inviteCode))).accountsPartial({ group, admin: me }).rpc(),

  archiveGroup: (p: HonorProgram, me: PublicKey, group: PublicKey) =>
    p.methods.archiveGroup().accountsPartial({ group, admin: me }).rpc(),

  joinGroup: (p: HonorProgram, me: PublicKey, group: PublicKey, code: string) =>
    p.methods
      .joinGroup(code)
      .accountsPartial({ group, profile: addr.profile(me), membership: addr.member(group, me), user: me })
      .rpc(),

  async createRound(
    p: HonorProgram,
    me: PublicKey,
    group: PublicKey,
    r: { question: string; options: string[]; challenge: string; evidence: EvidenceKind; closeAt: number; resolveSecs: number; challengeSecs: number },
  ) {
    const g = await p.account.group.fetch(group);
    const round = addr.round(group, g.roundCount);
    const evidence = r.evidence === "aiCheck" ? { aiCheck: {} } : { groupVote: {} };
    await p.methods
      .createRound(r.question, r.options, r.challenge, evidence, new BN(r.closeAt), new BN(r.resolveSecs), new BN(r.challengeSecs))
      .accountsPartial({ group, membership: addr.member(group, me), round, creator: me })
      .rpc();
    return round;
  },

  predict: (p: HonorProgram, me: PublicKey, round: PublicKey, group: PublicKey, choice: number, confidence: number) =>
    p.methods
      .predict(choice, confidence)
      .accountsPartial({ round, membership: addr.member(group, me), prediction: addr.prediction(round, me), user: me })
      .rpc(),

  voteOutcome: (p: HonorProgram, me: PublicKey, round: PublicKey, outcome: number) =>
    p.methods.voteOutcome(outcome).accountsPartial({ round, prediction: addr.prediction(round, me), user: me }).rpc(),

  finalize: (p: HonorProgram, me: PublicKey, round: PublicKey) =>
    p.methods.finalizeOutcome().accountsPartial({ round, cranker: me }).rpc(),

  /** Settles everyone's prediction, a few per transaction. Anyone can do this. */
  async settleAll(p: HonorProgram, me: PublicKey, round: PublicKey, r: Round, users: PublicKey[]) {
    const ixs = await Promise.all(
      users.map((u) =>
        p.methods
          .settlePrediction()
          .accountsPartial({
            round,
            prediction: addr.prediction(round, u),
            profile: addr.profile(u),
            membership: addr.member(r.group, u),
            cranker: me,
          })
          .instruction(),
      ),
    );
    for (let i = 0; i < ixs.length; i += 4) await sendIxs(p, ixs.slice(i, i + 4));
  },

  submitProof: (p: HonorProgram, me: PublicKey, round: PublicKey, group: PublicKey, hash: Uint8Array, uri: string) =>
    p.methods
      .submitProof(Array.from(hash), uri)
      .accountsPartial({ prediction: addr.prediction(round, me), group, user: me })
      .rpc(),

  review: (p: HonorProgram, me: PublicKey, round: PublicKey, pred: Prediction, approve: boolean) => {
    const prediction = addr.prediction(round, pred.user);
    return p.methods
      .reviewProof(approve)
      .accountsPartial({
        prediction,
        group: pred.group,
        reviewerMembership: addr.member(pred.group, me),
        reviewerProfile: addr.profile(me),
        userProfile: addr.profile(pred.user),
        userMembership: addr.member(pred.group, pred.user),
        review: addr.review(prediction, me, pred.reviewRound),
        reviewer: me,
      })
      .rpc();
  },

  decline: (p: HonorProgram, me: PublicKey, round: PublicKey, group: PublicKey) =>
    p.methods
      .declineChallenge()
      .accountsPartial({ prediction: addr.prediction(round, me), profile: addr.profile(me), membership: addr.member(group, me), user: me })
      .rpc(),

  useShield: (p: HonorProgram, me: PublicKey, round: PublicKey, group: PublicKey) =>
    p.methods
      .useShield()
      .accountsPartial({ prediction: addr.prediction(round, me), profile: addr.profile(me), membership: addr.member(group, me), user: me })
      .rpc(),

  expire: (p: HonorProgram, me: PublicKey, round: PublicKey, pred: Prediction) =>
    p.methods
      .expireChallenge()
      .accountsPartial({
        prediction: addr.prediction(round, pred.user),
        profile: addr.profile(pred.user),
        membership: addr.member(pred.group, pred.user),
        cranker: me,
      })
      .rpc(),
};

// ---------------------------------------------------------------- display helpers
export function honorRate(p: Profile | null | undefined): number | null {
  if (!p) return null;
  const owed = p.challengesCompleted + p.challengesFailed + p.challengesDeclined;
  return owed === 0 ? null : Math.round((p.challengesCompleted / owed) * 100);
}

export function odds(r: Round) {
  const n = r.options.length;
  const votes = r.votes.slice(0, n);
  const conf = r.confidenceSum.slice(0, n).map((x) => x.toNumber());
  const total = votes.reduce((a, b) => a + b, 0);
  const confTotal = conf.reduce((a, b) => a + b, 0);
  return r.options.map((label, i) => ({
    label,
    votes: votes[i],
    share: total ? votes[i] / total : 1 / n,
    weighted: confTotal ? conf[i] / confTotal : total ? votes[i] / total : 1 / n,
  }));
}

export function relTime(unix: number, now = Date.now() / 1000): string {
  const d = Math.round(unix - now);
  const abs = Math.abs(d);
  const fmt =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} d`;
  return d >= 0 ? `in ${fmt}` : `${fmt} ago`;
}

export function when(unix: number) {
  return new Date(unix * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function duration(s: number) {
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} ${s >= 2 * 86400 ? "days" : "day"}`;
}

export const short = (k: PublicKey | string) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

/** Only http(s) links are ever rendered: proof links are chain data anyone can write. */
export const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : null);

/** Turns Anchor / wallet errors into one readable sentence. */
export function errorMessage(e: unknown): string {
  const any = e as { error?: { errorMessage?: string }; message?: string; logs?: string[] };
  if (any?.error?.errorMessage) return any.error.errorMessage;
  const m = any?.message ?? String(e);
  const custom = m.match(/Error Message: ([^.]+\.?)/);
  if (custom) return custom[1];
  if (/already in use/.test(m) || any?.logs?.some((l) => /already in use/.test(l))) return "That's already been done.";
  if (/User rejected/i.test(m)) return "You cancelled the request in your wallet.";
  if (/429|too many requests/i.test(m)) return "The Solana test network is busy right now. Try again in a few seconds.";
  if (/program that does not exist/i.test(m)) return "The HONOR program isn't deployed on this network yet.";
  if (/insufficient (lamports|funds)|debit an account but found no record/i.test(m))
    return "Your wallet needs a little test SOL to pay network fees.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}
