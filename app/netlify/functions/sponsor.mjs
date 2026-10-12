// The hidden SOL bank. Players never touch SOL: when their game wallet can't pay for an action,
// the app sends the transaction here, already signed by the player, with the bank as fee payer
// and a first instruction that moves exactly the rent the action needs from the bank to the
// player. This function checks it strictly, counts it against the player's daily free plays,
// co-signs as the bank and sends it. The SOL is spent inside that same transaction, so it can't
// be redirected to anything else.
//
//   GET  -> { bank, used, limits }   (today's free plays for the signed-in player)
//   POST { transaction: base64 }     -> { signature } | { error, limitReached? }
//
// Netlify environment variables (Site configuration > Environment variables), all secret:
//   PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_VERIFICATION_KEY   from the Privy dashboard
//   BANK_SECRET_KEY   the bank wallet's secret key as a JSON array of 64 numbers
//   SOLANA_RPC_URL    optional, defaults to the public devnet RPC
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { importSPKI, jwtVerify } from "jose";
import { Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import idl from "../../src/idl/honor.json" with { type: "json" };
import rules from "../../src/sponsor-rules.json" with { type: "json" };

const PROGRAM_ID = new PublicKey(idl.address);
const discriminator = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
const KIND_BY_DISC = Object.fromEntries(idl.instructions.map((ix) => [discriminator(ix.name), ix.name]));

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const today = () => new Date().toISOString().slice(0, 10);

export default async (req) => {
  const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_VERIFICATION_KEY, BANK_SECRET_KEY } = process.env;
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_VERIFICATION_KEY || !BANK_SECRET_KEY)
    return json(500, { error: "The game's bank isn't set up yet." });
  let bank;
  try {
    bank = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(BANK_SECRET_KEY)));
  } catch {
    return json(500, { error: "The game's bank key is set up wrong (BANK_SECRET_KEY)." });
  }

  // 1. Who is asking? Only a valid Privy (Google) login gets an answer.
  let userId;
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const key = await importSPKI(toPem(PRIVY_VERIFICATION_KEY), "ES256");
    ({ payload: { sub: userId } } = await jwtVerify(token, key, { issuer: "privy.io", audience: PRIVY_APP_ID }));
  } catch {
    return json(401, { error: "Please sign in again." });
  }

  // Tests outside Netlify can supply an in-memory store.
  const store = globalThis.__HONOR_TEST_STORE__ ?? getStore({ name: "free-plays", consistency: "strong" });
  const dayKey = `${today()}/${userId}`;
  const used = (await store.get(dayKey, { type: "json" })) ?? {};
  const status = { bank: bank.publicKey.toBase58(), used, limits: rules.dailyLimits };
  if (req.method === "GET") return json(200, status);
  if (req.method !== "POST") return json(405, { error: "Use GET or POST" });

  // 2. Which wallet is theirs? Ask Privy once, then remember it: a player's wallet never changes.
  // This stops anyone making the bank pay for someone else's address.
  const walletKey = `wallet/${userId}`;
  let address = await store.get(walletKey);
  if (!address) {
    const res = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(userId)}`, {
      headers: {
        "privy-app-id": PRIVY_APP_ID,
        authorization: `Basic ${Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString("base64")}`,
      },
    });
    if (!res.ok) return json(502, { error: "Couldn't reach the login service. Try again in a minute." });
    const account = ((await res.json()).linked_accounts ?? []).find(
      (a) => a.type === "wallet" && a.chain_type === "solana" && (a.connector_type === "embedded" || a.wallet_client_type === "privy"),
    );
    if (!account) return json(409, { error: "Your account is still being set up. Try again in a few seconds." });
    address = account.address;
    await store.set(walletKey, address);
  }
  const player = new PublicKey(address);

  // 3. Check the transaction strictly.
  let tx;
  try {
    tx = Transaction.from(Buffer.from((await req.json()).transaction, "base64"));
  } catch {
    return json(400, { error: "Bad transaction." });
  }
  const bad = (why) => json(400, { error: `The bank can't pay for this: ${why}.` });
  if (!tx.feePayer?.equals(bank.publicKey)) return bad("wrong fee payer");
  const [first, ...game] = tx.instructions;
  if (!first || !first.programId.equals(SystemProgram.programId)) return bad("missing rent payment");
  let transfer;
  try {
    if (SystemInstruction.decodeInstructionType(first) !== "Transfer") throw 0;
    transfer = SystemInstruction.decodeTransfer(first);
  } catch {
    return bad("first step must be a plain transfer");
  }
  if (!transfer.fromPubkey.equals(bank.publicKey) || !transfer.toPubkey.equals(player)) return bad("transfer goes to the wrong wallet");
  if (!game.length) return bad("no game action");

  const counts = {};
  let rentSizes = [];
  for (const ix of game) {
    if (!ix.programId.equals(PROGRAM_ID)) return bad("only HONOR actions are allowed");
    // The bank signs only as fee payer and for its own transfer, never inside a game action.
    if (ix.keys.some((k) => k.pubkey.equals(bank.publicKey))) return bad("the bank can't take part in a game action");
    if (!ix.keys.some((k) => k.isSigner && k.pubkey.equals(player))) return bad("the action must be yours");
    const kind = KIND_BY_DISC[ix.data.subarray(0, 8).toString("hex")];
    if (!kind || !(kind in rules.dailyLimits || rules.alwaysFree.includes(kind))) return bad(`"${kind ?? "unknown"}" isn't a free action`);
    counts[kind] = (counts[kind] ?? 0) + 1;
    rentSizes = rentSizes.concat(rules.createdAccountSizes[kind] ?? []);
  }

  // The bank pays exactly the rent of the accounts this action creates, nothing more.
  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  let rent = 0;
  for (const size of rentSizes) rent += await connection.getMinimumBalanceForRentExemption(size);
  if (Number(transfer.lamports) !== rent) return bad("wrong amount");

  // 4. Daily limits.
  const total = (used.total ?? 0) + 1;
  if (total > rules.maxFreeTransactionsPerDay)
    return json(402, { error: "Daily limit reached: you've used all of today's free plays. They reset at midnight (UTC). To keep going now, add SOL to your game wallet with Phantom in My hall.", limitReached: true });
  for (const [kind, n] of Object.entries(counts)) {
    const limit = rules.dailyLimits[kind];
    if (limit !== undefined && (used[kind] ?? 0) + n > limit)
      return json(402, { error: limitMessage(kind, limit), limitReached: true, kind });
  }

  // 5. Co-sign as the bank and send. The player's signature must already be valid.
  if ((await connection.getBalance(bank.publicKey)) < rent + 20_000)
    return json(503, { error: "The game's bank is empty. Tell the organiser to top it up." });
  tx.partialSign(bank);
  if (!tx.verifySignatures()) return bad("missing your signature");
  let signature;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    await connection.confirmTransaction(signature, "confirmed");
  } catch (e) {
    // Program errors (e.g. "Voting for this round is closed") go back to the player in plain words.
    const logs = e?.logs ?? (await e?.getLogs?.(connection).catch(() => null)) ?? [];
    const message = logs.join("\n").match(/Error Message: ([^\n]+?)\.?$/m)?.[1];
    return json(422, { error: message ? `${message}.` : String(e?.message ?? e) });
  }

  const next = { ...used, total };
  for (const [kind, n] of Object.entries(counts)) if (kind in rules.dailyLimits) next[kind] = (used[kind] ?? 0) + n;
  await store.setJSON(dayKey, next);
  return json(200, { signature, used: next });
};

// Netlify's value fields are single-line, so the key may arrive with its line breaks turned into
// spaces, "\n" text, or nothing. Rebuild a proper PEM from whatever was pasted.
function toPem(raw) {
  const body = raw
    .replace(/\\n/g, " ")
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
}

function limitMessage(kind, limit) {
  const what =
    {
      predict: `${limit} free bets`,
      join_group: `${limit} free group join`,
      create_group: `${limit} free new group`,
      create_round: `${limit} free new round`,
    }[kind] ?? "free plays";
  return `Daily limit reached: you get ${what} a day, and you've used today's. It resets at midnight (UTC). To keep going now, add SOL to your game wallet with Phantom in My hall.`;
}
