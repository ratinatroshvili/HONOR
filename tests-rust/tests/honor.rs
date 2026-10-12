//! End-to-end tests for the HONOR program.
//!
//! Runs the real compiled program (target/deploy/honor.so) inside LiteSVM, an in-memory
//! Solana, so we can fast-forward the clock past voting, dispute and challenge deadlines.
//! Run `anchor build` first, then `cargo test -- --nocapture` in this folder (or `anchor test`).

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use honor::{accounts as acc, instruction as ixs, state::*, ID};
use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_sha256_hasher::hash;
use solana_signer::Signer;
use solana_transaction::Transaction;
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::system_program;

const INVITE: &str = "friday-crew-7f3k";
const HOUR: i64 = 3600;
const DISPUTE: i64 = 600;
const CHALLENGE: i64 = 86_400;

// ---------------------------------------------------------------- PDAs
fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &ID).0
}
fn profile_pda(u: &Pubkey) -> Pubkey {
    pda(&[b"profile", u.as_ref()])
}
fn group_pda(admin: &Pubkey, id: u64) -> Pubkey {
    pda(&[b"group", admin.as_ref(), &id.to_le_bytes()])
}
fn member_pda(g: &Pubkey, u: &Pubkey) -> Pubkey {
    pda(&[b"member", g.as_ref(), u.as_ref()])
}
fn round_pda(g: &Pubkey, id: u64) -> Pubkey {
    pda(&[b"round", g.as_ref(), &id.to_le_bytes()])
}
fn prediction_pda(r: &Pubkey, u: &Pubkey) -> Pubkey {
    pda(&[b"prediction", r.as_ref(), u.as_ref()])
}
fn review_pda(p: &Pubkey, reviewer: &Pubkey, review_round: u8) -> Pubkey {
    pda(&[b"review", p.as_ref(), reviewer.as_ref(), &[review_round]])
}

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: ID, accounts: accounts.to_account_metas(None), data: data.data() }
}

// ---------------------------------------------------------------- test harness
struct Game {
    svm: LiteSVM,
    group: Pubkey,
}

impl Game {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/honor.so");
        svm.add_program_from_file(ID, so).expect("run `anchor build` first");
        Game { svm, group: Pubkey::default() }
    }

    fn user(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        k
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn warp(&mut self, secs: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp += secs;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }

    /// Sends one instruction. Err contains the program logs so tests can check the error name.
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        let payer = signers[0].pubkey();
        let tx = Transaction::new(signers, Message::new(&[ix], Some(&payer)), self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res.map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn ok(&mut self, ix: Instruction, signers: &[&Keypair]) {
        if let Err(e) = self.send(ix, signers) {
            panic!("transaction should succeed but failed:\n{e}");
        }
    }

    fn fails(&mut self, ix: Instruction, signers: &[&Keypair], expected: &str) {
        match self.send(ix, signers) {
            Ok(()) => panic!("expected failure `{expected}` but transaction succeeded"),
            Err(e) => assert!(e.contains(expected), "expected `{expected}`, got:\n{e}"),
        }
    }

    fn get<T: AccountDeserialize>(&self, addr: &Pubkey) -> T {
        let a = self.svm.get_account(addr).expect("account missing");
        T::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    fn profile(&self, k: &Keypair) -> Profile {
        self.get(&profile_pda(&k.pubkey()))
    }
    fn prediction(&self, r: &Pubkey, k: &Keypair) -> Prediction {
        self.get(&prediction_pda(r, &k.pubkey()))
    }
    fn round(&self, r: &Pubkey) -> Round {
        self.get(r)
    }

    // ------------- instruction builders
    fn create_profile(&self, u: &Keypair, name: &str) -> Instruction {
        ix(
            acc::CreateProfile { profile: profile_pda(&u.pubkey()), authority: u.pubkey(), system_program: system_program::ID },
            ixs::CreateProfile { name: name.into() },
        )
    }
    fn join(&self, u: &Keypair, code: &str) -> Instruction {
        let g = self.group;
        ix(
            acc::JoinGroup {
                group: g,
                profile: profile_pda(&u.pubkey()),
                membership: member_pda(&g, &u.pubkey()),
                user: u.pubkey(),
                system_program: system_program::ID,
            },
            ixs::JoinGroup { invite_code: code.into() },
        )
    }
    fn create_round_with(&self, u: &Keypair, id: u64, question: &str, options: &[&str], close_at: i64, dispute: i64) -> Instruction {
        let g = self.group;
        ix(
            acc::CreateRound {
                group: g,
                membership: member_pda(&g, &u.pubkey()),
                round: round_pda(&g, id),
                creator: u.pubkey(),
                system_program: system_program::ID,
            },
            ixs::CreateRound {
                question: question.into(),
                options: options.iter().map(|s| s.to_string()).collect(),
                challenge: "30 push-ups".into(),
                evidence_source: "Group vote".into(),
                votes_close_at: close_at,
                dispute_window_secs: dispute,
                challenge_window_secs: CHALLENGE,
            },
        )
    }
    fn create_round(&self, u: &Keypair, id: u64) -> Instruction {
        self.create_round_with(u, id, "Will we finish the project by Friday?", &["Yes", "No"], self.now() + HOUR, DISPUTE)
    }
    fn predict(&self, u: &Keypair, r: &Pubkey, choice: u8, confidence: u8) -> Instruction {
        ix(
            acc::Predict {
                round: *r,
                membership: member_pda(&self.group, &u.pubkey()),
                prediction: prediction_pda(r, &u.pubkey()),
                user: u.pubkey(),
                system_program: system_program::ID,
            },
            ixs::Predict { choice, confidence },
        )
    }
    fn propose(&self, u: &Keypair, r: &Pubkey, outcome: u8) -> Instruction {
        ix(acc::ProposeOutcome { round: *r, group: self.group, authority: u.pubkey() }, ixs::ProposeOutcome { outcome })
    }
    fn dispute(&self, u: &Keypair, r: &Pubkey) -> Instruction {
        ix(
            acc::DisputeOutcome { round: *r, prediction: prediction_pda(r, &u.pubkey()), user: u.pubkey() },
            ixs::DisputeOutcome {},
        )
    }
    fn finalize(&self, cranker: &Keypair, r: &Pubkey) -> Instruction {
        let proposer = self.round(r).proposer;
        ix(
            acc::FinalizeOutcome {
                round: *r,
                proposer_profile: profile_pda(&proposer),
                proposer_membership: member_pda(&self.group, &proposer),
                cranker: cranker.pubkey(),
            },
            ixs::FinalizeOutcome {},
        )
    }
    fn settle(&self, cranker: &Keypair, r: &Pubkey, user: &Keypair) -> Instruction {
        let u = user.pubkey();
        ix(
            acc::SettlePrediction {
                round: *r,
                prediction: prediction_pda(r, &u),
                profile: profile_pda(&u),
                membership: member_pda(&self.group, &u),
                cranker: cranker.pubkey(),
            },
            ixs::SettlePrediction {},
        )
    }
    fn submit_proof(&self, u: &Keypair, r: &Pubkey, proof_hash: [u8; 32], uri: &str) -> Instruction {
        ix(
            acc::SubmitProof { prediction: prediction_pda(r, &u.pubkey()), group: self.group, user: u.pubkey() },
            ixs::SubmitProof { proof_hash, proof_uri: uri.into() },
        )
    }
    fn review(&self, reviewer: &Keypair, r: &Pubkey, user: &Keypair, approve: bool) -> Instruction {
        let pred = prediction_pda(r, &user.pubkey());
        let review_round = self.get::<Prediction>(&pred).review_round;
        let g = self.group;
        ix(
            acc::ReviewProof {
                prediction: pred,
                group: g,
                reviewer_membership: member_pda(&g, &reviewer.pubkey()),
                reviewer_profile: profile_pda(&reviewer.pubkey()),
                user_profile: profile_pda(&user.pubkey()),
                user_membership: member_pda(&g, &user.pubkey()),
                review: review_pda(&pred, &reviewer.pubkey(), review_round),
                reviewer: reviewer.pubkey(),
                system_program: system_program::ID,
            },
            ixs::ReviewProof { approve },
        )
    }
    fn own_accounts(&self, u: &Keypair, r: &Pubkey) -> acc::OwnChallenge {
        acc::OwnChallenge { prediction: prediction_pda(r, &u.pubkey()), profile: profile_pda(&u.pubkey()), user: u.pubkey() }
    }
    fn decline(&self, u: &Keypair, r: &Pubkey) -> Instruction {
        ix(self.own_accounts(u, r), ixs::DeclineChallenge {})
    }
    fn use_shield(&self, u: &Keypair, r: &Pubkey) -> Instruction {
        ix(self.own_accounts(u, r), ixs::UseShield {})
    }
    fn expire(&self, cranker: &Keypair, r: &Pubkey, user: &Keypair) -> Instruction {
        ix(
            acc::ExpireChallenge {
                prediction: prediction_pda(r, &user.pubkey()),
                profile: profile_pda(&user.pubkey()),
                cranker: cranker.pubkey(),
            },
            ixs::ExpireChallenge {},
        )
    }
    fn buy_shield(&self, u: &Keypair) -> Instruction {
        ix(acc::UpdateProfile { profile: profile_pda(&u.pubkey()), authority: u.pubkey() }, ixs::BuyShield {})
    }
    fn cancel(&self, u: &Keypair, r: &Pubkey) -> Instruction {
        ix(acc::CancelRound { round: *r, group: self.group, admin: u.pubkey() }, ixs::CancelRound {})
    }
}

#[test]
fn no_instruction_can_move_honor_points() {
    let idl: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/idl/honor.json")).unwrap(),
    )
    .unwrap();
    for i in idl["instructions"].as_array().unwrap() {
        let name = i["name"].as_str().unwrap().to_lowercase();
        for banned in ["transfer", "withdraw", "redeem", "mint", "send"] {
            assert!(!name.contains(banned), "instruction {name} looks like it moves points");
        }
    }
}

#[test]
fn full_game() {
    let mut g = Game::new();
    let maya = g.user(); // group admin
    let alex = g.user();
    let sam = g.user();
    let rati = g.user();
    let eve = g.user(); // outsider who never gets the invite

    // ---------------------------------------------------------- profiles
    for (k, n) in [(&maya, "Maya"), (&alex, "Alex"), (&sam, "Sam"), (&rati, "Rati"), (&eve, "Eve")] {
        let i = g.create_profile(k, n);
        g.ok(i, &[k]);
    }
    assert_eq!(g.profile(&maya).name, "Maya");
    let i = g.create_profile(&maya, "Maya again");
    g.fails(i, &[&maya], "already in use");
    let blank = g.user();
    let i = g.create_profile(&blank, "   ");
    g.fails(i, &[&blank], "InvalidName");
    println!("✔ profiles");

    // ---------------------------------------------------------- group + invite code
    g.group = group_pda(&maya.pubkey(), 0);
    let i = ix(
        acc::CreateGroup {
            profile: profile_pda(&maya.pubkey()),
            group: g.group,
            membership: member_pda(&g.group, &maya.pubkey()),
            admin: maya.pubkey(),
            system_program: system_program::ID,
        },
        ixs::CreateGroup { name: "Friday Crew".into(), invite_hash: hash(INVITE.as_bytes()).to_bytes() },
    );
    g.ok(i, &[&maya]);
    let i = g.join(&eve, "wrong-code");
    g.fails(i, &[&eve], "WrongInviteCode");
    for k in [&alex, &sam, &rati] {
        let i = g.join(k, INVITE);
        g.ok(i, &[k]);
    }
    let i = g.join(&alex, INVITE);
    g.fails(i, &[&alex], "already in use");

    // Only the admin can make a new invite link, and the old one stops working.
    let rotate = |k: &Keypair, code: &str| {
        ix(acc::RotateInvite { group: group_pda(&maya.pubkey(), 0), admin: k.pubkey() }, ixs::RotateInvite { invite_hash: hash(code.as_bytes()).to_bytes() })
    };
    g.fails(rotate(&alex, "hijack"), &[&alex], "NotRoundAuthority");
    g.ok(rotate(&maya, "new-code"), &[&maya]);
    let i = g.join(&eve, INVITE);
    g.fails(i, &[&eve], "WrongInviteCode");
    let grp: Group = g.get(&g.group);
    assert_eq!(grp.member_count, 4);
    assert_eq!(grp.name, "Friday Crew");
    println!("✔ group: only invite-code holders can join");

    // ---------------------------------------------------------- round rules are validated and locked
    let i = g.create_round(&eve, 0);
    g.fails(i, &[&eve], "AccountNotInitialized"); // not a member
    let now = g.now();
    let i = g.create_round_with(&maya, 0, "Q?", &["A", "B", "C", "D", "E"], now + HOUR, DISPUTE);
    g.fails(i, &[&maya], "InvalidOptions");
    let i = g.create_round_with(&maya, 0, "Q?", &["Yes", "No"], now - 10, DISPUTE);
    g.fails(i, &[&maya], "DeadlineInPast");
    let i = g.create_round_with(&maya, 0, "Q?", &["Yes", "No"], now + HOUR, 5);
    g.fails(i, &[&maya], "InvalidWindow");

    let r0 = round_pda(&g.group, 0);
    let i = g.create_round(&maya, 0);
    g.ok(i, &[&maya]);
    let round = g.round(&r0);
    assert_eq!(round.question, "Will we finish the project by Friday?");
    assert_eq!(round.challenge, "30 push-ups");
    assert_eq!(round.options, vec!["Yes".to_string(), "No".to_string()]);
    println!("✔ round created with locked rules");

    // ---------------------------------------------------------- predictions & odds
    for (k, c, conf) in [(&maya, 0, 80), (&alex, 0, 60), (&sam, 1, 90), (&rati, 1, 50)] {
        let i = g.predict(k, &r0, c, conf);
        g.ok(i, &[k]);
    }
    let i = g.predict(&sam, &r0, 0, 10);
    g.fails(i, &[&sam], "already in use");
    let i = g.predict(&eve, &r0, 0, 10);
    g.fails(i, &[&eve], "AccountNotInitialized");
    let round = g.round(&r0);
    assert_eq!(&round.votes[..2], &[2, 2]);
    assert_eq!(&round.confidence_sum[..2], &[140, 140]);
    assert_eq!(round.total_votes, 4);
    println!("✔ predictions recorded; odds Yes 50% / No 50%");

    // ---------------------------------------------------------- proposing the outcome
    let i = g.propose(&maya, &r0, 0);
    g.fails(i, &[&maya], "VotingStillOpen");
    g.warp(HOUR + 1);
    let late = g.user();
    let _ = late; // (voting closed: any further predict would fail with VotingClosed)
    let i = g.propose(&sam, &r0, 1);
    g.fails(i, &[&sam], "NotRoundAuthority");
    let i = g.propose(&maya, &r0, 7);
    g.fails(i, &[&maya], "InvalidChoice");
    let i = g.propose(&maya, &r0, 0);
    g.ok(i, &[&maya]);
    assert_eq!(g.round(&r0).status, RoundStatus::Proposed);

    // ---------------------------------------------------------- minority dispute
    let i = g.dispute(&sam, &r0);
    g.ok(i, &[&sam]);
    let i = g.dispute(&sam, &r0);
    g.fails(i, &[&sam], "AlreadyDisputed");
    let i = g.finalize(&alex, &r0);
    g.fails(i, &[&alex], "DisputeWindowOpen");
    g.warp(DISPUTE + 1);
    let i = g.dispute(&rati, &r0);
    g.fails(i, &[&rati], "DisputeWindowClosed");
    let i = g.finalize(&alex, &r0); // anyone can finalize
    g.ok(i, &[&alex]);
    let round = g.round(&r0);
    assert_eq!(round.status, RoundStatus::Resolved);
    assert_eq!(round.outcome, 0);
    assert_eq!(g.profile(&maya).honor_points, 2); // fair-play for resolving = Honor
    assert_eq!(g.profile(&maya).prediction_points, 0);
    println!("✔ outcome proposed, minority dispute logged, round resolved");

    // ---------------------------------------------------------- settling
    for k in [&maya, &alex, &sam, &rati] {
        let i = g.settle(&eve, &r0, k); // permissionless crank
        g.ok(i, &[&eve]);
    }
    let i = g.settle(&eve, &r0, &sam);
    g.fails(i, &[&eve], "WrongChallengeStatus");
    // Being right earns Prediction Points only.
    assert_eq!(g.profile(&maya).prediction_points, 14); // 10 + 80/20
    assert_eq!(g.profile(&maya).honor_points, 2); // unchanged by being right
    assert_eq!(g.profile(&alex).prediction_points, 13); // 10 + 60/20
    assert_eq!(g.profile(&alex).honor_points, 0);
    assert_eq!(g.profile(&sam).prediction_points, 0);
    assert_eq!(g.prediction(&r0, &sam).status, ChallengeStatus::Pending);
    assert_eq!(g.prediction(&r0, &rati).status, ChallengeStatus::Pending);
    assert_eq!(g.profile(&sam).wrong_predictions, 1);
    println!("✔ settled: Maya +14 PP, Alex +13 PP (Prediction Points), Sam & Rati owe 30 push-ups");

    // ---------------------------------------------------------- proof + peer review
    let i = g.submit_proof(&sam, &r0, [0u8; 32], "");
    g.fails(i, &[&sam], "EmptyProofHash");
    let proof = hash(b"sam-pushups-video-bytes").to_bytes();
    let i = g.submit_proof(&sam, &r0, proof, "https://example.com/unlisted/sam");
    g.ok(i, &[&sam]);
    let p = g.prediction(&r0, &sam);
    assert_eq!(p.approvals_needed, 2);
    assert_eq!(p.proof_hash, proof);

    let i = g.review(&sam, &r0, &sam, true);
    g.fails(i, &[&sam], "CannotReviewOwnProof");
    let i = g.review(&eve, &r0, &sam, true);
    g.fails(i, &[&eve], "AccountNotInitialized");
    let i = g.review(&maya, &r0, &sam, true);
    g.ok(i, &[&maya]);
    let i = g.review(&maya, &r0, &sam, true);
    g.fails(i, &[&maya], "already in use");
    let i = g.review(&alex, &r0, &sam, true);
    g.ok(i, &[&alex]);
    assert_eq!(g.prediction(&r0, &sam).status, ChallengeStatus::Completed);
    let s = g.profile(&sam);
    // Doing the challenge earns Honor Points only.
    assert_eq!(s.honor_points, 15);
    assert_eq!(s.prediction_points, 0);
    assert_eq!(s.challenges_completed, 1);
    assert_eq!(g.profile(&alex).honor_points, 2); // fair-play for reviewing
    assert_eq!(s.current_streak, 1);
    assert_eq!(g.profile(&alex).fair_play_actions, 1);
    println!("✔ Sam's proof approved by 2 friends: challenge completed, +15 Honor");

    // ---------------------------------------------------------- rejection, resubmission, expiry
    let i = g.submit_proof(&rati, &r0, hash(b"blurry video").to_bytes(), "");
    g.ok(i, &[&rati]);
    let i = g.review(&maya, &r0, &rati, false);
    g.ok(i, &[&maya]);
    let i = g.review(&sam, &r0, &rati, false);
    g.ok(i, &[&sam]);
    assert_eq!(g.prediction(&r0, &rati).status, ChallengeStatus::Pending);
    let i = g.submit_proof(&rati, &r0, hash(b"better video").to_bytes(), "");
    g.ok(i, &[&rati]);
    assert_eq!(g.prediction(&r0, &rati).review_round, 2);
    let i = g.review(&maya, &r0, &rati, false); // same friend may review the new proof
    g.ok(i, &[&maya]);
    let i = g.review(&alex, &r0, &rati, false);
    g.ok(i, &[&alex]);
    let i = g.expire(&eve, &r0, &rati);
    g.fails(i, &[&eve], "ChallengeDeadlineNotReached");
    g.warp(CHALLENGE + 1);
    let i = g.submit_proof(&rati, &r0, hash(b"late").to_bytes(), "");
    g.fails(i, &[&rati], "ChallengeDeadlinePassed");
    let i = g.expire(&eve, &r0, &rati);
    g.ok(i, &[&eve]);
    let r = g.profile(&rati);
    assert_eq!(r.challenges_failed, 1);
    assert_eq!(r.current_streak, 0);
    println!("✔ rejected proof goes back; missed deadline marked failed");

    // ---------------------------------------------------------- majority dispute overturns
    let r1 = round_pda(&g.group, 1);
    let now = g.now();
    let i = g.create_round_with(&alex, 1, "Will it rain on Saturday?", &["Yes", "No"], now + HOUR, DISPUTE);
    g.ok(i, &[&alex]);
    for (k, c) in [(&maya, 0), (&alex, 0), (&sam, 1), (&rati, 1)] {
        let i = g.predict(k, &r1, c, 50);
        g.ok(i, &[k]);
    }
    g.warp(HOUR + 1);
    let i = g.propose(&alex, &r1, 0);
    g.ok(i, &[&alex]);
    for k in [&sam, &rati] {
        let i = g.dispute(k, &r1);
        g.ok(i, &[k]);
    }
    assert_eq!(g.round(&r1).status, RoundStatus::Proposed); // 2 of 4 is not a majority
    let i = g.dispute(&maya, &r1);
    g.ok(i, &[&maya]);
    assert_eq!(g.round(&r1).status, RoundStatus::Disputed);
    let i = g.settle(&eve, &r1, &maya);
    g.fails(i, &[&eve], "WrongRoundStatus");
    let i = g.propose(&maya, &r1, 1); // admin re-proposes
    g.ok(i, &[&maya]);
    assert_eq!(g.round(&r1).proposal_count, 2);
    let i = g.dispute(&maya, &r1); // new proposal => can dispute again
    g.ok(i, &[&maya]);
    g.warp(DISPUTE + 1);
    let i = g.finalize(&eve, &r1);
    g.ok(i, &[&eve]);
    assert_eq!(g.round(&r1).outcome, 1);
    println!("✔ majority dispute threw out a wrong result; corrected result finalized");

    // ---------------------------------------------------------- cancel
    let r2 = round_pda(&g.group, 2);
    let i = g.create_round(&sam, 2);
    g.ok(i, &[&sam]);
    let i = g.predict(&sam, &r2, 0, 100);
    g.ok(i, &[&sam]);
    let i = g.cancel(&sam, &r2);
    g.fails(i, &[&sam], "NotRoundAuthority");
    let i = g.cancel(&maya, &r2);
    g.ok(i, &[&maya]);
    let i = g.settle(&eve, &r2, &sam);
    g.ok(i, &[&eve]);
    assert_eq!(g.prediction(&r2, &sam).status, ChallengeStatus::Void);
    println!("✔ admin cancelled a round; predictions voided");

    // ---------------------------------------------------------- decline & shields
    for k in [&maya, &alex, &sam, &rati] {
        let i = g.settle(&eve, &r1, k);
        g.ok(i, &[&eve]);
    }
    let i = g.decline(&alex, &r1); // Alex was wrong in round 1
    g.ok(i, &[&alex]);
    assert_eq!(g.profile(&alex).challenges_declined, 1);

    let i = g.buy_shield(&rati);
    g.fails(i, &[&rati], "NotEnoughPoints");
    let mut id = 3;
    while g.profile(&maya).prediction_points < SHIELD_COST {
        let r = round_pda(&g.group, id);
        let i = g.create_round(&maya, id);
        g.ok(i, &[&maya]);
        let i = g.predict(&maya, &r, 0, 100);
        g.ok(i, &[&maya]);
        g.warp(HOUR + 1);
        let i = g.propose(&maya, &r, 0);
        g.ok(i, &[&maya]);
        g.warp(DISPUTE + 1);
        let i = g.finalize(&maya, &r);
        g.ok(i, &[&maya]);
        let i = g.settle(&maya, &r, &maya);
        g.ok(i, &[&maya]);
        id += 1;
    }
    let before = g.profile(&maya);
    let i = g.buy_shield(&maya);
    g.ok(i, &[&maya]);
    let after = g.profile(&maya);
    assert_eq!(after.shields, 1);
    assert_eq!(after.prediction_points, before.prediction_points - SHIELD_COST); // paid in Prediction Points
    assert_eq!(after.lifetime_prediction_points, before.lifetime_prediction_points); // leaderboard unaffected
    assert_eq!(after.honor_points, before.honor_points); // Honor is never spent
    let i = g.use_shield(&maya, &r1); // Maya was wrong in round 1
    g.ok(i, &[&maya]);
    let m = g.profile(&maya);
    assert_eq!(m.shields, 0);
    assert_eq!(m.challenges_shielded, 1);
    assert!(m.current_streak > 0); // shield keeps the streak
    assert_eq!(g.prediction(&r1, &maya).status, ChallengeStatus::Shielded);
    println!("✔ decline is voluntary; shields cost 50 Prediction Points and keep the streak");

    // ---------------------------------------------------------- leaderboard
    let mut rows: Vec<(String, u64, u64, u32)> = [&maya, &alex, &sam, &rati]
        .iter()
        .map(|k| {
            let m: Membership = g.get(&member_pda(&g.group, &k.pubkey()));
            let p = g.profile(k);
            let accuracy = 100 * p.correct_predictions / (p.correct_predictions + p.wrong_predictions).max(1);
            (p.name, m.prediction_points, m.honor_points, accuracy)
        })
        .collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    println!("✔ Friday Crew (name, prediction pts, honor pts, accuracy %): {:?}", rows);
    assert_eq!(rows[0].0, "Maya");
    // The two scores tell different stories: Sam and Rati both have 12 Prediction Points
    // and 50% accuracy, but Sam did his challenge (Honor 17) and Rati missed hers (Honor 0).
    let row = |n: &str| rows.iter().find(|r| r.0 == n).unwrap().clone();
    assert_eq!((row("Sam").1, row("Sam").3), (row("Rati").1, row("Rati").3));
    assert_eq!(row("Sam").2, 17);
    assert_eq!(row("Rati").2, 0);
}
