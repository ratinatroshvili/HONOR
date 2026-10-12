//! HONOR v2: a prediction game for friend groups.
//!
//! Friends predict outcomes inside private groups. When predictions close, everyone who
//! predicted votes on what actually happened and the majority decides. The wrong side owes
//! the agreed challenge (e.g. 30 push-ups), proves it with an off-chain video whose sha256
//! is stored here, and friends approve it.
//!
//! Two separate scores:
//! - Prediction Points: earned only by being right. Spendable on shields.
//! - Honor Points: keeping your word. Up for completing challenges and fair play, down for
//!   failing or declining them. Can go negative (rank: FUFLO).
//!
//! No money moves anywhere: points are non-transferable, cannot be bought and cannot be
//! redeemed. Nothing can be cancelled or deleted: once a round starts, it plays out and stays
//! on record. Groups can be archived (no new rounds), never erased.
//!
//! The whole program is in this one file so it can be pasted into Solana Playground.
//! It is written to compile with both Anchor 0.29 (Playground) and 0.32.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

declare_id!("6xEqRDwzB6jNYostdTKeCpft75QAvAZF2T7TPm8MgD6q");

// ---------------------------------------------------------------------- limits

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_QUESTION_LEN: usize = 140;
pub const MAX_OPTION_LEN: usize = 32;
pub const MAX_OPTIONS: usize = 4;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_CHALLENGE_LEN: usize = 100;
pub const MAX_PROOF_URI_LEN: usize = 160;

// Time windows (seconds). Minimums are short so a full round can be demoed live.
pub const MIN_WINDOW_SECS: i64 = 60;
pub const MAX_RESOLVE_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
pub const MAX_CHALLENGE_WINDOW_SECS: i64 = 14 * 24 * 60 * 60;
/// Extra time friends get to review proof submitted close to the deadline.
pub const REVIEW_GRACE_SECS: i64 = 2 * 24 * 60 * 60;

/// A round needs at least this many predictions to produce a result (no solo rounds).
pub const MIN_VOTERS: u32 = 2;
/// Proof can be submitted at most this many times per challenge.
pub const MAX_PROOF_ATTEMPTS: u8 = 3;
pub const MAX_APPROVALS_NEEDED: u16 = 2;
/// `Prediction::outcome_vote` before the voter has voted on the result.
pub const NO_VOTE: u8 = u8::MAX;

// ---------------------------------------------------------------------- points

/// Prediction Points for a correct call, plus +1 per 20% confidence (max +5).
pub const PREDICTION_CORRECT_BASE: u64 = 10;
pub const PREDICTION_CONFIDENCE_BONUS_MAX: u64 = 5;
/// Shields are paid in Prediction Points.
pub const SHIELD_COST: u64 = 50;

/// Honor Points. Following through pays; backing out costs.
pub const HONOR_CHALLENGE_COMPLETED: i64 = 15;
/// Reviewing proof, or voting for the result the group agreed on.
pub const HONOR_FAIR_PLAY: i64 = 2;
pub const HONOR_CHALLENGE_FAILED: i64 = -20;
pub const HONOR_CHALLENGE_DECLINED: i64 = -10;

#[program]
pub mod honor {
    use super::*;

    // ------------------------------------------------------------------ profiles

    /// First and last name are both required.
    pub fn create_profile(ctx: Context<CreateProfile>, first_name: String, last_name: String) -> Result<()> {
        validate_text(&first_name, MAX_NAME_LEN, HonorError::InvalidName)?;
        validate_text(&last_name, MAX_NAME_LEN, HonorError::InvalidName)?;
        let p = &mut ctx.accounts.profile;
        p.authority = ctx.accounts.authority.key();
        p.first_name = first_name;
        p.last_name = last_name;
        p.created_at = Clock::get()?.unix_timestamp;
        p.bump = ctx.bumps.profile;
        Ok(())
    }

    pub fn buy_shield(ctx: Context<UpdateProfile>) -> Result<()> {
        let p = &mut ctx.accounts.profile;
        require!(p.prediction_points >= SHIELD_COST, HonorError::NotEnoughPoints);
        p.prediction_points -= SHIELD_COST;
        p.shields = p.shields.checked_add(1).ok_or(HonorError::Overflow)?;
        Ok(())
    }

    // ------------------------------------------------------------------ groups

    /// `invite_hash` = sha256(invite code). The code travels in the invite link only.
    pub fn create_group(ctx: Context<CreateGroup>, name: String, invite_hash: [u8; 32]) -> Result<()> {
        validate_text(&name, MAX_NAME_LEN, HonorError::InvalidName)?;
        let now = Clock::get()?.unix_timestamp;
        let profile = &mut ctx.accounts.profile;
        let group = &mut ctx.accounts.group;
        group.admin = ctx.accounts.admin.key();
        group.group_id = profile.groups_created;
        group.name = name;
        group.invite_hash = invite_hash;
        group.member_count = 1;
        group.created_at = now;
        group.bump = ctx.bumps.group;
        profile.groups_created += 1;

        let m = &mut ctx.accounts.membership;
        m.group = group.key();
        m.user = ctx.accounts.admin.key();
        m.joined_at = now;
        m.bump = ctx.bumps.membership;
        Ok(())
    }

    /// Admin makes a new invite link. Old links stop working.
    pub fn rotate_invite(ctx: Context<AdminGroup>, invite_hash: [u8; 32]) -> Result<()> {
        let group = &mut ctx.accounts.group;
        require!(!group.archived, HonorError::GroupArchived);
        group.invite_hash = invite_hash;
        Ok(())
    }

    /// Admin removes the group: nobody can join or start rounds any more. Rounds already
    /// running play out, and every round, prediction and point stays on record.
    pub fn archive_group(ctx: Context<AdminGroup>) -> Result<()> {
        let group = &mut ctx.accounts.group;
        require!(!group.archived, HonorError::GroupArchived);
        group.archived = true;
        group.archived_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn join_group(ctx: Context<JoinGroup>, invite_code: String) -> Result<()> {
        let group = &mut ctx.accounts.group;
        require!(!group.archived, HonorError::GroupArchived);
        require!(hash(invite_code.as_bytes()).to_bytes() == group.invite_hash, HonorError::WrongInviteCode);
        group.member_count = group.member_count.checked_add(1).ok_or(HonorError::Overflow)?;
        let m = &mut ctx.accounts.membership;
        m.group = group.key();
        m.user = ctx.accounts.user.key();
        m.joined_at = Clock::get()?.unix_timestamp;
        m.bump = ctx.bumps.membership;
        Ok(())
    }

    // ------------------------------------------------------------------ rounds

    /// The rules (question, options, challenge, evidence, deadlines) are locked here and
    /// can never be edited or cancelled.
    #[allow(clippy::too_many_arguments)]
    pub fn create_round(
        ctx: Context<CreateRound>,
        question: String,
        options: Vec<String>,
        challenge: String,
        evidence: EvidenceKind,
        votes_close_at: i64,
        resolve_window_secs: i64,
        challenge_window_secs: i64,
    ) -> Result<()> {
        validate_text(&question, MAX_QUESTION_LEN, HonorError::InvalidQuestion)?;
        require!(
            options.len() >= MIN_OPTIONS && options.len() <= MAX_OPTIONS,
            HonorError::InvalidOptions
        );
        for o in &options {
            validate_text(o, MAX_OPTION_LEN, HonorError::InvalidOptions)?;
        }
        validate_text(&challenge, MAX_CHALLENGE_LEN, HonorError::InvalidChallenge)?;
        require!(
            (MIN_WINDOW_SECS..=MAX_RESOLVE_WINDOW_SECS).contains(&resolve_window_secs),
            HonorError::InvalidWindow
        );
        require!(
            (MIN_WINDOW_SECS..=MAX_CHALLENGE_WINDOW_SECS).contains(&challenge_window_secs),
            HonorError::InvalidWindow
        );
        let now = Clock::get()?.unix_timestamp;
        require!(votes_close_at > now, HonorError::DeadlineInPast);

        let group = &mut ctx.accounts.group;
        require!(!group.archived, HonorError::GroupArchived);
        require!(group.member_count >= MIN_VOTERS, HonorError::NeedMoreMembers);

        let r = &mut ctx.accounts.round;
        r.group = group.key();
        r.round_id = group.round_count;
        r.creator = ctx.accounts.creator.key();
        r.question = question;
        r.options = options;
        r.challenge = challenge;
        r.evidence = evidence;
        r.votes_close_at = votes_close_at;
        r.resolve_window_secs = resolve_window_secs;
        r.challenge_window_secs = challenge_window_secs;
        r.status = RoundStatus::Open;
        r.created_at = now;
        r.bump = ctx.bumps.round;
        group.round_count += 1;
        Ok(())
    }

    pub fn predict(ctx: Context<Predict>, choice: u8, confidence: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.round;
        require!(r.status == RoundStatus::Open, HonorError::WrongRoundStatus);
        require!(now < r.votes_close_at, HonorError::VotingClosed);
        require!((choice as usize) < r.options.len(), HonorError::InvalidChoice);
        require!(confidence <= 100, HonorError::InvalidConfidence);

        let i = choice as usize;
        r.votes[i] += 1;
        r.confidence_sum[i] += confidence as u64;
        r.total_votes += 1;

        let p = &mut ctx.accounts.prediction;
        p.round = r.key();
        p.group = r.group;
        p.user = ctx.accounts.user.key();
        p.choice = choice;
        p.confidence = confidence;
        p.created_at = now;
        p.outcome_vote = NO_VOTE;
        p.status = ChallengeStatus::Unsettled;
        p.bump = ctx.bumps.prediction;
        Ok(())
    }

    /// Group vote on the result: after predictions close, everyone who predicted votes once
    /// on what actually happened. As soon as one answer has a majority of all predictors,
    /// the round is resolved.
    pub fn vote_outcome(ctx: Context<VoteOutcome>, outcome: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.round;
        let p = &mut ctx.accounts.prediction;
        require!(r.status == RoundStatus::Open, HonorError::WrongRoundStatus);
        require!(now >= r.votes_close_at, HonorError::VotingStillOpen);
        require!(now < r.votes_close_at + r.resolve_window_secs, HonorError::ResultVoteClosed);
        require!((outcome as usize) < r.options.len(), HonorError::InvalidChoice);
        require!(p.outcome_vote == NO_VOTE, HonorError::AlreadyVoted);

        p.outcome_vote = outcome;
        let i = outcome as usize;
        r.outcome_votes[i] += 1;
        r.outcome_vote_count += 1;
        if r.total_votes >= MIN_VOTERS && (r.outcome_votes[i] as u64) * 2 > r.total_votes as u64 {
            r.status = RoundStatus::Resolved;
            r.outcome = outcome;
            r.resolved_at = now;
        }
        Ok(())
    }

    /// Anyone can close the result vote once its window ends (or everyone has voted).
    /// The answer with the most votes wins. A tie, no votes, or fewer than two predictors
    /// means there is no result: the round ends void and nobody owes anything.
    pub fn finalize_outcome(ctx: Context<FinalizeOutcome>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.round;
        require!(r.status == RoundStatus::Open, HonorError::WrongRoundStatus);
        require!(now >= r.votes_close_at, HonorError::VotingStillOpen);
        let window_over = now >= r.votes_close_at + r.resolve_window_secs;
        let everyone_voted = r.total_votes > 0 && r.outcome_vote_count == r.total_votes;
        require!(window_over || everyone_voted, HonorError::ResultVoteOpen);

        let mut best = 0usize;
        let mut tie = false;
        for i in 1..r.options.len() {
            if r.outcome_votes[i] > r.outcome_votes[best] {
                best = i;
                tie = false;
            } else if r.outcome_votes[i] == r.outcome_votes[best] {
                tie = true;
            }
        }
        r.resolved_at = now;
        if r.total_votes < MIN_VOTERS || r.outcome_vote_count == 0 || tie {
            r.status = RoundStatus::Void;
        } else {
            r.status = RoundStatus::Resolved;
            r.outcome = best as u8;
        }
        Ok(())
    }

    // ------------------------------------------------------------------ settling & challenges

    /// Permissionless: anyone can settle anyone's prediction once the round has ended,
    /// so the wrong side cannot dodge their challenge by never clicking "settle".
    pub fn settle_prediction(ctx: Context<SettlePrediction>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &ctx.accounts.round;
        let p = &mut ctx.accounts.prediction;
        require!(p.status == ChallengeStatus::Unsettled, HonorError::WrongChallengeStatus);

        if r.status == RoundStatus::Void {
            p.status = ChallengeStatus::Void;
            return Ok(());
        }
        require!(r.status == RoundStatus::Resolved, HonorError::WrongRoundStatus);

        let prof = &mut ctx.accounts.profile;
        let m = &mut ctx.accounts.membership;

        // Voting for the result the group agreed on is fair play, win or lose.
        if p.outcome_vote == r.outcome {
            prof.fair_play_actions += 1;
            add_honor(prof, m, HONOR_FAIR_PLAY);
        }

        if p.choice == r.outcome {
            let points =
                PREDICTION_CORRECT_BASE + std::cmp::min(PREDICTION_CONFIDENCE_BONUS_MAX, p.confidence as u64 / 20);
            p.status = ChallengeStatus::Won;
            p.points_awarded = points;
            prof.correct_predictions += 1;
            bump_streak(prof);
            award_prediction(prof, m, points)?;
        } else {
            // The clock starts when the debt is recorded, never in the past.
            p.status = ChallengeStatus::Pending;
            p.challenge_deadline = std::cmp::max(now, r.resolved_at) + r.challenge_window_secs;
            prof.wrong_predictions += 1;
        }
        Ok(())
    }

    /// The person who owes the challenge submits proof. Only the sha256 of the file is
    /// required; `proof_uri` is optional (use an unlisted link: it is public on-chain).
    pub fn submit_proof(ctx: Context<SubmitProof>, proof_hash: [u8; 32], proof_uri: String) -> Result<()> {
        require!(proof_hash != [0u8; 32], HonorError::EmptyProofHash);
        require!(proof_uri.len() <= MAX_PROOF_URI_LEN, HonorError::ProofUriTooLong);
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.prediction;
        require!(p.status == ChallengeStatus::Pending, HonorError::WrongChallengeStatus);
        require!(now <= p.challenge_deadline, HonorError::ChallengeDeadlinePassed);
        require!(p.review_round < MAX_PROOF_ATTEMPTS, HonorError::TooManyAttempts);

        let others = ctx.accounts.group.member_count.saturating_sub(1) as u16;
        p.approvals_needed = std::cmp::max(1, std::cmp::min(MAX_APPROVALS_NEEDED, others));
        p.status = ChallengeStatus::ProofSubmitted;
        p.proof_hash = proof_hash;
        p.proof_uri = proof_uri;
        p.proof_submitted_at = now;
        p.review_round += 1;
        p.approvals = 0;
        p.rejections = 0;
        Ok(())
    }

    /// Another group member reviews the proof. Enough approvals completes the challenge;
    /// enough rejections sends it back so the user can try again before the deadline.
    pub fn review_proof(ctx: Context<ReviewProof>, approve: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let reviewer = ctx.accounts.reviewer.key();
        let p = &mut ctx.accounts.prediction;
        require!(reviewer != p.user, HonorError::CannotReviewOwnProof);
        require!(p.status == ChallengeStatus::ProofSubmitted, HonorError::WrongChallengeStatus);

        let rev = &mut ctx.accounts.review;
        rev.prediction = p.key();
        rev.reviewer = reviewer;
        rev.review_round = p.review_round;
        rev.approve = approve;
        rev.created_at = now;
        rev.bump = ctx.bumps.review;

        if approve {
            p.approvals += 1;
        } else {
            p.rejections += 1;
        }

        // Reviewing is fair play either way. Proof attempts are capped, so this can't be
        // farmed by rejecting the same challenge over and over.
        let rp = &mut ctx.accounts.reviewer_profile;
        rp.fair_play_actions += 1;
        add_honor(rp, &mut ctx.accounts.reviewer_membership, HONOR_FAIR_PLAY);

        if p.approvals >= p.approvals_needed {
            complete(p, &mut ctx.accounts.user_profile, &mut ctx.accounts.user_membership);
        } else if p.rejections >= p.approvals_needed {
            p.status = ChallengeStatus::Pending;
        }
        Ok(())
    }

    /// Voluntary: anyone can decline a challenge. It is recorded, costs Honor Points and
    /// breaks the streak.
    pub fn decline_challenge(ctx: Context<OwnChallenge>) -> Result<()> {
        let p = &mut ctx.accounts.prediction;
        require!(
            p.status == ChallengeStatus::Pending || p.status == ChallengeStatus::ProofSubmitted,
            HonorError::WrongChallengeStatus
        );
        p.status = ChallengeStatus::Declined;
        let prof = &mut ctx.accounts.profile;
        prof.challenges_declined += 1;
        prof.current_streak = 0;
        add_honor(prof, &mut ctx.accounts.membership, HONOR_CHALLENGE_DECLINED);
        Ok(())
    }

    /// Spend a shield to skip a challenge without losing Honor Points or the streak.
    pub fn use_shield(ctx: Context<OwnChallenge>) -> Result<()> {
        let p = &mut ctx.accounts.prediction;
        require!(p.status == ChallengeStatus::Pending, HonorError::WrongChallengeStatus);
        let prof = &mut ctx.accounts.profile;
        require!(prof.shields > 0, HonorError::NoShields);
        prof.shields -= 1;
        prof.challenges_shielded += 1;
        p.status = ChallengeStatus::Shielded;
        Ok(())
    }

    /// Permissionless. After the deadline with no proof, the challenge is failed. Proof that
    /// friends never finished reviewing is decided after a grace period: it counts only if
    /// more friends approved it than rejected it, so unreviewed proof can't dodge a challenge.
    pub fn expire_challenge(ctx: Context<ExpireChallenge>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.prediction;
        let prof = &mut ctx.accounts.profile;
        let m = &mut ctx.accounts.membership;
        if p.status == ChallengeStatus::Pending {
            require!(now > p.challenge_deadline, HonorError::ChallengeDeadlineNotReached);
            fail(p, prof, m);
        } else if p.status == ChallengeStatus::ProofSubmitted {
            require!(
                now > p.challenge_deadline + REVIEW_GRACE_SECS,
                HonorError::ChallengeDeadlineNotReached
            );
            if p.approvals > p.rejections {
                complete(p, prof, m);
            } else {
                fail(p, prof, m);
            }
        } else {
            return err!(HonorError::WrongChallengeStatus);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------- helpers

fn validate_text(s: &str, max: usize, err: HonorError) -> Result<()> {
    if s.trim().is_empty() || s.len() > max {
        return Err(err.into());
    }
    Ok(())
}

fn award_prediction(profile: &mut Profile, membership: &mut Membership, points: u64) -> Result<()> {
    profile.prediction_points = profile.prediction_points.checked_add(points).ok_or(HonorError::Overflow)?;
    profile.lifetime_prediction_points =
        profile.lifetime_prediction_points.checked_add(points).ok_or(HonorError::Overflow)?;
    membership.prediction_points = membership.prediction_points.checked_add(points).ok_or(HonorError::Overflow)?;
    Ok(())
}

fn add_honor(profile: &mut Profile, membership: &mut Membership, delta: i64) {
    profile.honor_points = profile.honor_points.saturating_add(delta);
    membership.honor_points = membership.honor_points.saturating_add(delta);
}

fn bump_streak(p: &mut Profile) {
    p.current_streak += 1;
    if p.current_streak > p.best_streak {
        p.best_streak = p.current_streak;
    }
}

fn complete(p: &mut Prediction, prof: &mut Profile, m: &mut Membership) {
    p.status = ChallengeStatus::Completed;
    p.points_awarded = HONOR_CHALLENGE_COMPLETED as u64;
    prof.challenges_completed += 1;
    bump_streak(prof);
    add_honor(prof, m, HONOR_CHALLENGE_COMPLETED);
}

fn fail(p: &mut Prediction, prof: &mut Profile, m: &mut Membership) {
    p.status = ChallengeStatus::Failed;
    prof.challenges_failed += 1;
    prof.current_streak = 0;
    add_honor(prof, m, HONOR_CHALLENGE_FAILED);
}

// ---------------------------------------------------------------------- state

pub const PROFILE_SEED: &[u8] = b"profile";
pub const GROUP_SEED: &[u8] = b"group";
pub const MEMBER_SEED: &[u8] = b"member";
pub const ROUND_SEED: &[u8] = b"round";
pub const PREDICTION_SEED: &[u8] = b"prediction";
pub const REVIEW_SEED: &[u8] = b"review";

/// One per wallet. Points live here and can never be transferred, bought or redeemed:
/// there is simply no instruction that moves them between accounts.
#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub authority: Pubkey,
    #[max_len(MAX_NAME_LEN)]
    pub first_name: String,
    #[max_len(MAX_NAME_LEN)]
    pub last_name: String,
    /// Earned by correct predictions. Spendable on shields.
    pub prediction_points: u64,
    /// All Prediction Points ever earned (for leaderboards). Never decreases.
    pub lifetime_prediction_points: u64,
    /// Keeping your word. Decides the rank; below zero is FUFLO.
    pub honor_points: i64,
    pub correct_predictions: u32,
    pub wrong_predictions: u32,
    pub challenges_completed: u32,
    pub challenges_failed: u32,
    pub challenges_declined: u32,
    pub challenges_shielded: u32,
    pub fair_play_actions: u32,
    pub current_streak: u32,
    pub best_streak: u32,
    pub shields: u8,
    pub groups_created: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Group {
    pub admin: Pubkey,
    pub group_id: u64,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    /// sha256 of the invite code. Whoever has the invite link can join.
    pub invite_hash: [u8; 32],
    pub member_count: u32,
    pub round_count: u64,
    /// Archived groups take no new members or rounds. Their records stay forever.
    pub archived: bool,
    pub archived_at: i64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Membership {
    pub group: Pubkey,
    pub user: Pubkey,
    /// Points earned inside this group, for the group leaderboards.
    pub prediction_points: u64,
    pub honor_points: i64,
    pub joined_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EvidenceKind {
    /// Everyone who predicted votes on what happened.
    GroupVote,
    /// AI checks the evidence (beta). Until it ships, these rounds also use the group vote.
    AiCheck,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RoundStatus {
    /// Predictions open, then the result vote.
    Open,
    Resolved,
    /// No result (tie, no result votes, or too few players). Nobody owes anything.
    Void,
}

/// A prediction question. Its rules are fixed at creation and can never be edited.
#[account]
#[derive(InitSpace)]
pub struct Round {
    pub group: Pubkey,
    pub round_id: u64,
    pub creator: Pubkey,
    #[max_len(MAX_QUESTION_LEN)]
    pub question: String,
    #[max_len(MAX_OPTIONS, MAX_OPTION_LEN)]
    pub options: Vec<String>,
    /// The challenge the wrong side has to do, e.g. "30 push-ups".
    #[max_len(MAX_CHALLENGE_LEN)]
    pub challenge: String,
    pub evidence: EvidenceKind,
    pub votes_close_at: i64,
    /// How long the result vote stays open after predictions close.
    pub resolve_window_secs: i64,
    pub challenge_window_secs: i64,
    /// Predictions per option (vote-share odds).
    pub votes: [u32; MAX_OPTIONS],
    /// Sum of confidence (0-100) per option (confidence-weighted odds).
    pub confidence_sum: [u64; MAX_OPTIONS],
    pub total_votes: u32,
    /// Result votes per option.
    pub outcome_votes: [u32; MAX_OPTIONS],
    pub outcome_vote_count: u32,
    pub status: RoundStatus,
    pub outcome: u8,
    pub resolved_at: i64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ChallengeStatus {
    /// Round not settled yet for this prediction.
    Unsettled,
    /// Predicted correctly, nothing to do.
    Won,
    /// Predicted wrong: the challenge is owed.
    Pending,
    /// Proof submitted, waiting for friends to review.
    ProofSubmitted,
    Completed,
    Failed,
    Declined,
    Shielded,
    /// The round ended without a result.
    Void,
}

#[account]
#[derive(InitSpace)]
pub struct Prediction {
    pub round: Pubkey,
    pub group: Pubkey,
    pub user: Pubkey,
    pub choice: u8,
    pub confidence: u8,
    pub created_at: i64,
    /// This voter's answer in the result vote (`NO_VOTE` until they vote).
    pub outcome_vote: u8,
    pub status: ChallengeStatus,
    /// Prediction Points for a win, Honor Points for a completed challenge.
    pub points_awarded: u64,
    pub challenge_deadline: i64,
    /// sha256 of the proof video/photo. The file itself stays off-chain.
    pub proof_hash: [u8; 32],
    #[max_len(MAX_PROOF_URI_LEN)]
    pub proof_uri: String,
    pub proof_submitted_at: i64,
    /// Number of proof submissions so far (max `MAX_PROOF_ATTEMPTS`).
    pub review_round: u8,
    pub approvals: u16,
    pub rejections: u16,
    pub approvals_needed: u16,
    pub bump: u8,
}

/// Exists only to stop the same friend reviewing the same proof twice.
#[account]
#[derive(InitSpace)]
pub struct ProofReview {
    pub prediction: Pubkey,
    pub reviewer: Pubkey,
    pub review_round: u8,
    pub approve: bool,
    pub created_at: i64,
    pub bump: u8,
}

#[error_code]
pub enum HonorError {
    #[msg("Names must be 1-32 characters")]
    InvalidName,
    #[msg("Question must be 1-140 characters")]
    InvalidQuestion,
    #[msg("A round needs 2-4 options, each 1-32 characters")]
    InvalidOptions,
    #[msg("Challenge must be 1-100 characters")]
    InvalidChallenge,
    #[msg("Time window is out of range")]
    InvalidWindow,
    #[msg("Voting deadline must be in the future")]
    DeadlineInPast,
    #[msg("Wrong invite code")]
    WrongInviteCode,
    #[msg("This group has been removed")]
    GroupArchived,
    #[msg("Invite at least one friend before starting a round")]
    NeedMoreMembers,
    #[msg("Voting for this round is closed")]
    VotingClosed,
    #[msg("Voting is still open")]
    VotingStillOpen,
    #[msg("Not a valid option")]
    InvalidChoice,
    #[msg("Confidence must be between 0 and 100")]
    InvalidConfidence,
    #[msg("The round is not in the right state for this action")]
    WrongRoundStatus,
    #[msg("The result vote has ended")]
    ResultVoteClosed,
    #[msg("The result vote is still running")]
    ResultVoteOpen,
    #[msg("You already voted on the result")]
    AlreadyVoted,
    #[msg("This prediction is not in the right state for this action")]
    WrongChallengeStatus,
    #[msg("Challenge deadline has passed")]
    ChallengeDeadlinePassed,
    #[msg("Challenge deadline has not passed yet")]
    ChallengeDeadlineNotReached,
    #[msg("No proof attempts left for this challenge")]
    TooManyAttempts,
    #[msg("You cannot review your own proof")]
    CannotReviewOwnProof,
    #[msg("Not enough Prediction Points")]
    NotEnoughPoints,
    #[msg("No shields left")]
    NoShields,
    #[msg("Proof link is too long")]
    ProofUriTooLong,
    #[msg("Proof hash cannot be empty")]
    EmptyProofHash,
    #[msg("Math overflow")]
    Overflow,
}

// ---------------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct CreateProfile<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, authority.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    #[account(mut, seeds = [PROFILE_SEED, authority.key().as_ref()], bump = profile.bump)]
    pub profile: Account<'info, Profile>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateGroup<'info> {
    #[account(mut, seeds = [PROFILE_SEED, admin.key().as_ref()], bump = profile.bump)]
    pub profile: Account<'info, Profile>,
    #[account(
        init,
        payer = admin,
        space = 8 + Group::INIT_SPACE,
        seeds = [GROUP_SEED, admin.key().as_ref(), &profile.groups_created.to_le_bytes()],
        bump
    )]
    pub group: Account<'info, Group>,
    #[account(
        init,
        payer = admin,
        space = 8 + Membership::INIT_SPACE,
        seeds = [MEMBER_SEED, group.key().as_ref(), admin.key().as_ref()],
        bump
    )]
    pub membership: Account<'info, Membership>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminGroup<'info> {
    #[account(mut, has_one = admin)]
    pub group: Account<'info, Group>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct JoinGroup<'info> {
    #[account(mut)]
    pub group: Account<'info, Group>,
    /// Must have a profile first, so leaderboards always have a name.
    #[account(seeds = [PROFILE_SEED, user.key().as_ref()], bump = profile.bump)]
    pub profile: Account<'info, Profile>,
    #[account(
        init,
        payer = user,
        space = 8 + Membership::INIT_SPACE,
        seeds = [MEMBER_SEED, group.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub membership: Account<'info, Membership>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub group: Account<'info, Group>,
    #[account(
        seeds = [MEMBER_SEED, group.key().as_ref(), creator.key().as_ref()],
        bump = membership.bump
    )]
    pub membership: Account<'info, Membership>,
    #[account(
        init,
        payer = creator,
        space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, group.key().as_ref(), &group.round_count.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Predict<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        seeds = [MEMBER_SEED, round.group.as_ref(), user.key().as_ref()],
        bump = membership.bump
    )]
    pub membership: Account<'info, Membership>,
    #[account(
        init,
        payer = user,
        space = 8 + Prediction::INIT_SPACE,
        seeds = [PREDICTION_SEED, round.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub prediction: Account<'info, Prediction>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VoteOutcome<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [PREDICTION_SEED, round.key().as_ref(), user.key().as_ref()],
        bump = prediction.bump
    )]
    pub prediction: Account<'info, Prediction>,
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeOutcome<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
    /// Anyone can crank this.
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettlePrediction<'info> {
    pub round: Account<'info, Round>,
    #[account(mut, has_one = round)]
    pub prediction: Account<'info, Prediction>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, prediction.user.as_ref()],
        bump = profile.bump
    )]
    pub profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, round.group.as_ref(), prediction.user.as_ref()],
        bump = membership.bump
    )]
    pub membership: Account<'info, Membership>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(
        mut,
        has_one = group,
        seeds = [PREDICTION_SEED, prediction.round.as_ref(), user.key().as_ref()],
        bump = prediction.bump
    )]
    pub prediction: Account<'info, Prediction>,
    pub group: Account<'info, Group>,
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReviewProof<'info> {
    #[account(mut, has_one = group)]
    pub prediction: Account<'info, Prediction>,
    pub group: Account<'info, Group>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, group.key().as_ref(), reviewer.key().as_ref()],
        bump = reviewer_membership.bump
    )]
    pub reviewer_membership: Account<'info, Membership>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, reviewer.key().as_ref()],
        bump = reviewer_profile.bump
    )]
    pub reviewer_profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, prediction.user.as_ref()],
        bump = user_profile.bump
    )]
    pub user_profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, group.key().as_ref(), prediction.user.as_ref()],
        bump = user_membership.bump
    )]
    pub user_membership: Account<'info, Membership>,
    #[account(
        init,
        payer = reviewer,
        space = 8 + ProofReview::INIT_SPACE,
        seeds = [REVIEW_SEED, prediction.key().as_ref(), reviewer.key().as_ref(), &[prediction.review_round]],
        bump
    )]
    pub review: Account<'info, ProofReview>,
    #[account(mut)]
    pub reviewer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnChallenge<'info> {
    #[account(
        mut,
        seeds = [PREDICTION_SEED, prediction.round.as_ref(), user.key().as_ref()],
        bump = prediction.bump
    )]
    pub prediction: Account<'info, Prediction>,
    #[account(mut, seeds = [PROFILE_SEED, user.key().as_ref()], bump = profile.bump)]
    pub profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, prediction.group.as_ref(), user.key().as_ref()],
        bump = membership.bump
    )]
    pub membership: Account<'info, Membership>,
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExpireChallenge<'info> {
    #[account(mut)]
    pub prediction: Account<'info, Prediction>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, prediction.user.as_ref()],
        bump = profile.bump
    )]
    pub profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, prediction.group.as_ref(), prediction.user.as_ref()],
        bump = membership.bump
    )]
    pub membership: Account<'info, Membership>,
    pub cranker: Signer<'info>,
}
