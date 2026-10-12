// Generates app/src/idl/honor.json and honor-types.ts from the spec below.
//
// Solana Playground (Anchor 0.29) can't emit the IDL format this app's Anchor client needs,
// so the IDL is written by hand here. It MUST mirror programs/honor/src/lib.rs exactly:
// instruction account order, field order and types. Discriminators are computed the same
// way Anchor does (sha256 of "global:<ix>" / "account:<Name>", first 8 bytes).
//
// Run from app/: node scripts/gen-idl.cjs
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { convertIdlToCamelCase } = require("@coral-xyz/anchor/dist/cjs/idl.js");

const ADDRESS = "6xEqRDwzB6jNYostdTKeCpft75QAvAZF2T7TPm8MgD6q";
const disc = (s) => Array.from(crypto.createHash("sha256").update(s).digest().subarray(0, 8));

// Accounts: name + flags. "w" = writable, "s" = signer, "sys" = system program.
const acc = (spec) =>
  spec.split(" ").map((t) => {
    const [name, flags = ""] = t.split(":");
    if (flags === "sys") return { name, address: "11111111111111111111111111111111" };
    const a = { name };
    if (flags.includes("w")) a.writable = true;
    if (flags.includes("s")) a.signer = true;
    return a;
  });
const args = (...pairs) => pairs.map(([name, type]) => ({ name, type }));
const def = (name) => ({ defined: { name } });
const hash32 = { array: ["u8", 32] };

const instructions = [
  ["archive_group", "group:w admin:s", []],
  ["buy_shield", "profile:w authority:s", []],
  ["create_group", "profile:w group:w membership:w admin:ws system_program:sys", args(["name", "string"], ["invite_hash", hash32])],
  ["create_profile", "profile:w authority:ws system_program:sys", args(["first_name", "string"], ["last_name", "string"])],
  [
    "create_round",
    "group:w membership round:w creator:ws system_program:sys",
    args(
      ["question", "string"],
      ["options", { vec: "string" }],
      ["challenge", "string"],
      ["evidence", def("EvidenceKind")],
      ["votes_close_at", "i64"],
      ["resolve_window_secs", "i64"],
      ["challenge_window_secs", "i64"],
    ),
  ],
  ["decline_challenge", "prediction:w profile:w membership:w user:s", []],
  ["expire_challenge", "prediction:w profile:w membership:w cranker:s", []],
  ["finalize_outcome", "round:w cranker:s", []],
  ["join_group", "group:w profile membership:w user:ws system_program:sys", args(["invite_code", "string"])],
  ["predict", "round:w membership prediction:w user:ws system_program:sys", args(["choice", "u8"], ["confidence", "u8"])],
  [
    "review_proof",
    "prediction:w group reviewer_membership:w reviewer_profile:w user_profile:w user_membership:w review:w reviewer:ws system_program:sys",
    args(["approve", "bool"]),
  ],
  ["rotate_invite", "group:w admin:s", args(["invite_hash", hash32])],
  ["settle_prediction", "round prediction:w profile:w membership:w cranker:s", []],
  ["submit_proof", "prediction:w group user:s", args(["proof_hash", hash32], ["proof_uri", "string"])],
  ["use_shield", "prediction:w profile:w membership:w user:s", []],
  ["vote_outcome", "round:w prediction:w user:s", args(["outcome", "u8"])],
].map(([name, accounts, a]) => ({ name, discriminator: disc(`global:${name}`), accounts: acc(accounts), args: a }));

const struct = (name, fields) => ({ name, type: { kind: "struct", fields: fields.map(([n, t]) => ({ name: n, type: t })) } });
const enm = (name, variants) => ({ name, type: { kind: "enum", variants: variants.map((v) => ({ name: v })) } });

// Field order = declaration order in lib.rs.
const accountTypes = [
  struct("Group", [
    ["admin", "pubkey"], ["group_id", "u64"], ["name", "string"], ["invite_hash", hash32], ["member_count", "u32"],
    ["round_count", "u64"], ["archived", "bool"], ["archived_at", "i64"], ["created_at", "i64"], ["bump", "u8"],
  ]),
  struct("Membership", [
    ["group", "pubkey"], ["user", "pubkey"], ["prediction_points", "u64"], ["honor_points", "i64"], ["joined_at", "i64"], ["bump", "u8"],
  ]),
  struct("Prediction", [
    ["round", "pubkey"], ["group", "pubkey"], ["user", "pubkey"], ["choice", "u8"], ["confidence", "u8"], ["created_at", "i64"],
    ["outcome_vote", "u8"], ["status", def("ChallengeStatus")], ["points_awarded", "u64"], ["challenge_deadline", "i64"],
    ["proof_hash", hash32], ["proof_uri", "string"], ["proof_submitted_at", "i64"], ["review_round", "u8"], ["approvals", "u16"],
    ["rejections", "u16"], ["approvals_needed", "u16"], ["bump", "u8"],
  ]),
  struct("Profile", [
    ["authority", "pubkey"], ["first_name", "string"], ["last_name", "string"], ["prediction_points", "u64"],
    ["lifetime_prediction_points", "u64"], ["honor_points", "i64"], ["correct_predictions", "u32"], ["wrong_predictions", "u32"],
    ["challenges_completed", "u32"], ["challenges_failed", "u32"], ["challenges_declined", "u32"], ["challenges_shielded", "u32"],
    ["fair_play_actions", "u32"], ["current_streak", "u32"], ["best_streak", "u32"], ["shields", "u8"], ["groups_created", "u64"],
    ["created_at", "i64"], ["bump", "u8"],
  ]),
  struct("ProofReview", [
    ["prediction", "pubkey"], ["reviewer", "pubkey"], ["review_round", "u8"], ["approve", "bool"], ["created_at", "i64"], ["bump", "u8"],
  ]),
  struct("Round", [
    ["group", "pubkey"], ["round_id", "u64"], ["creator", "pubkey"], ["question", "string"], ["options", { vec: "string" }],
    ["challenge", "string"], ["evidence", def("EvidenceKind")], ["votes_close_at", "i64"], ["resolve_window_secs", "i64"],
    ["challenge_window_secs", "i64"], ["votes", { array: ["u32", 4] }], ["confidence_sum", { array: ["u64", 4] }],
    ["total_votes", "u32"], ["outcome_votes", { array: ["u32", 4] }], ["outcome_vote_count", "u32"], ["status", def("RoundStatus")],
    ["outcome", "u8"], ["resolved_at", "i64"], ["created_at", "i64"], ["bump", "u8"],
  ]),
];

const types = [
  enm("ChallengeStatus", ["Unsettled", "Won", "Pending", "ProofSubmitted", "Completed", "Failed", "Declined", "Shielded", "Void"]),
  enm("EvidenceKind", ["GroupVote", "AiCheck"]),
  ...accountTypes.slice(0, 5),
  accountTypes[5],
  enm("RoundStatus", ["Open", "Resolved", "Void"]),
].sort((a, b) => a.name.localeCompare(b.name));

// Same order as `#[error_code] enum HonorError` in lib.rs.
const errors = [
  ["InvalidName", "Names must be 1-32 characters"],
  ["InvalidQuestion", "Question must be 1-140 characters"],
  ["InvalidOptions", "A round needs 2-4 options, each 1-32 characters"],
  ["InvalidChallenge", "Challenge must be 1-100 characters"],
  ["InvalidWindow", "Time window is out of range"],
  ["DeadlineInPast", "Voting deadline must be in the future"],
  ["WrongInviteCode", "Wrong invite code"],
  ["GroupArchived", "This group has been removed"],
  ["NeedMoreMembers", "Invite at least one friend before starting a round"],
  ["VotingClosed", "Voting for this round is closed"],
  ["VotingStillOpen", "Voting is still open"],
  ["InvalidChoice", "Not a valid option"],
  ["InvalidConfidence", "Confidence must be between 0 and 100"],
  ["WrongRoundStatus", "The round is not in the right state for this action"],
  ["ResultVoteClosed", "The result vote has ended"],
  ["ResultVoteOpen", "The result vote is still running"],
  ["AlreadyVoted", "You already voted on the result"],
  ["WrongChallengeStatus", "This prediction is not in the right state for this action"],
  ["ChallengeDeadlinePassed", "Challenge deadline has passed"],
  ["ChallengeDeadlineNotReached", "Challenge deadline has not passed yet"],
  ["TooManyAttempts", "No proof attempts left for this challenge"],
  ["CannotReviewOwnProof", "You cannot review your own proof"],
  ["NotEnoughPoints", "Not enough Prediction Points"],
  ["NoShields", "No shields left"],
  ["ProofUriTooLong", "Proof link is too long"],
  ["EmptyProofHash", "Proof hash cannot be empty"],
  ["Overflow", "Math overflow"],
].map(([name, msg], i) => ({ code: 6000 + i, name, msg }));

const idl = {
  address: ADDRESS,
  metadata: {
    name: "honor",
    version: "0.2.0",
    spec: "0.1.0",
    description: "HONOR: social prediction game with on-chain, non-transferable points",
  },
  instructions,
  accounts: accountTypes.map((t) => ({ name: t.name, discriminator: disc(`account:${t.name}`) })),
  errors,
  types,
};

const out = path.join(__dirname, "..", "src", "idl");
fs.writeFileSync(path.join(out, "honor.json"), JSON.stringify(idl, null, 2) + "\n");
const camel = convertIdlToCamelCase(idl);
fs.writeFileSync(
  path.join(out, "honor-types.ts"),
  "/**\n * Program IDL in camelCase format in order to be used in JS/TS.\n *\n" +
    " * Generated by scripts/gen-idl.cjs. This is only a type helper; the IDL itself is honor.json.\n */\n" +
    `export type Honor = ${JSON.stringify(camel, null, 2)};\n`,
);
console.log(`IDL written: ${instructions.length} instructions, ${accountTypes.length} accounts, ${errors.length} errors`);
