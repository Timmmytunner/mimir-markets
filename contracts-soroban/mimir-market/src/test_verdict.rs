#![cfg(test)]
//! Versioned verdict encoding.
//!
//! Covers the explicit version tag written at resolution, the refusal of
//! unknown versions on both the write and read paths, the boundary versions,
//! and the backward-compatible read path for claims resolved before verdicts
//! were versioned.

extern crate std;

use crate::storage::DataKey;
use crate::test_common::{Fixture, USDC};
use crate::types::{ClaimState, Error, Verdict, WinnerSide, VERDICT_VERSION_V1};

/// A funded, expired, challenged claim: the smallest market that can resolve.
fn active_claim(f: &Fixture) -> u64 {
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client()
        .challenge_claim(&challenger, &id, &(10 * USDC), &None);
    f.advance_by(3_600);
    id
}

fn resolved_claim(f: &Fixture, verdict: Verdict) -> u64 {
    let id = active_claim(f);
    f.client()
        .resolve_claim_versioned(&id, &verdict, &f.str("resolved"), &90, &f.zero_hash());
    id
}

/// Simulate a claim resolved by a pre-versioning build: drop the versioned
/// record so only `Claim.winner_side` remains.
fn drop_versioned_record(f: &Fixture, id: u64) {
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().persistent().remove(&DataKey::Verdict(id));
    });
}

/// Simulate a verdict written by a build whose version this contract predates.
fn write_raw_verdict(f: &Fixture, id: u64, verdict: Verdict) {
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Verdict(id), &verdict);
    });
}

// ── Positive ─────────────────────────────────────────────────────────────────

/// The legacy entry point (bare `WinnerSide`) still works and records the
/// explicit version tag, so existing callers are not broken.
#[test]
fn legacy_entrypoint_records_a_versioned_verdict() {
    let f = Fixture::new(0, 0);
    let id = active_claim(&f);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator wins"),
        &90,
        &f.zero_hash(),
    );

    let verdict = f.client().get_verdict(&id);
    assert_eq!(verdict.version, VERDICT_VERSION_V1);
    assert_eq!(verdict.side, WinnerSide::Creator);
    assert_eq!(f.client().get_verdict_side(&id), WinnerSide::Creator);

    // The compatibility mirror on the claim struct still carries the same side.
    assert_eq!(f.client().get_claim(&id).winner_side, WinnerSide::Creator);
}

/// Every settled side round-trips through the versioned entry point.
#[test]
fn all_settled_sides_round_trip_through_the_version_tag() {
    for side in [
        WinnerSide::Creator,
        WinnerSide::Challengers,
        WinnerSide::Draw,
        WinnerSide::Unresolvable,
    ] {
        let f = Fixture::new(0, 0);
        let id = resolved_claim(&f, Verdict::current(side));
        let verdict = f.client().get_verdict(&id);
        assert_eq!(verdict.version, VERDICT_VERSION_V1);
        assert_eq!(verdict.decode().unwrap(), side);
        assert_eq!(f.client().get_verdict_side(&id), side);
    }
}

/// A challenger-side verdict resolved through the versioned entry point settles
/// exactly like the legacy entry point: the escrow is owed to challengers and a
/// pull succeeds.
#[test]
fn versioned_entrypoint_settles_the_same_as_the_legacy_one() {
    let f = Fixture::new(0, 0);
    let id = resolved_claim(&f, Verdict::current(WinnerSide::Challengers));

    assert_eq!(f.client().get_claim(&id).state, ClaimState::Resolved);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 20 * USDC);
    assert_eq!(f.client().get_verdict(&id).side, WinnerSide::Challengers);
}

// ── Negative ─────────────────────────────────────────────────────────────────

/// An unknown encoding version is refused before any state changes: the claim
/// stays active and the escrow is untouched.
#[test]
fn unknown_verdict_version_is_refused_without_touching_state() {
    let f = Fixture::new(0, 0);
    let id = active_claim(&f);

    let err = f
        .client()
        .try_resolve_claim_versioned(
            &id,
            &Verdict {
                version: 2,
                side: WinnerSide::Creator,
            },
            &f.str("future encoding"),
            &90,
            &f.zero_hash(),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::UnsupportedVerdictVersion);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);
    assert_eq!(f.escrow_balance(), 20 * USDC);
}

/// `None` is not a settled verdict, even when correctly versioned.
#[test]
fn a_versioned_none_side_is_refused() {
    let f = Fixture::new(0, 0);
    let id = active_claim(&f);

    let err = f
        .client()
        .try_resolve_claim_versioned(
            &id,
            &Verdict::current(WinnerSide::None),
            &f.str("no verdict"),
            &90,
            &f.zero_hash(),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidVerdict);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);
}

/// A stored verdict from a newer encoding must not be decoded as V1 on read.
#[test]
fn an_unknown_stored_version_is_refused_on_read() {
    let f = Fixture::new(0, 0);
    let id = resolved_claim(&f, Verdict::current(WinnerSide::Creator));

    write_raw_verdict(
        &f,
        id,
        Verdict {
            version: 99,
            side: WinnerSide::Creator,
        },
    );

    let err = f.client().try_get_verdict(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::UnsupportedVerdictVersion);
    let err = f.client().try_get_verdict_side(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::UnsupportedVerdictVersion);
}

// ── Boundary ─────────────────────────────────────────────────────────────────

/// Version 0 and the u32 ceiling are both unknown encodings, not V1.
#[test]
fn boundary_versions_are_refused() {
    let f = Fixture::new(0, 0);
    let id = active_claim(&f);

    for version in [0u32, u32::MAX] {
        let err = f
            .client()
            .try_resolve_claim_versioned(
                &id,
                &Verdict {
                    version,
                    side: WinnerSide::Creator,
                },
                &f.str("boundary"),
                &90,
                &f.zero_hash(),
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::UnsupportedVerdictVersion);
    }
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);
}

/// An unresolved claim has no verdict at all, rather than a default side.
#[test]
fn an_unresolved_claim_reports_no_verdict() {
    let f = Fixture::new(0, 0);
    let id = active_claim(&f);

    let err = f.client().try_get_verdict(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimNotResolved);
    let err = f.client().try_get_verdict_side(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimNotResolved);
}

// ── Backward compatibility ───────────────────────────────────────────────────

/// A claim resolved before verdicts were versioned (no versioned record) is
/// reported as a V1 verdict decoded from `Claim.winner_side`.
#[test]
fn a_pre_versioning_claim_decodes_from_the_stored_side() {
    let f = Fixture::new(0, 0);
    let id = resolved_claim(&f, Verdict::current(WinnerSide::Draw));
    // Drop the versioned record: this is exactly the pre-versioning shape.
    drop_versioned_record(&f, id);

    let verdict = f.client().get_verdict(&id);
    assert_eq!(verdict.version, VERDICT_VERSION_V1);
    assert_eq!(verdict.side, WinnerSide::Draw);
    assert_eq!(f.client().get_verdict_side(&id), WinnerSide::Draw);
}

/// The read fallback must not mistake an unresolved claim for a V1 verdict.
#[test]
fn the_fallback_does_not_dress_up_an_unresolved_claim() {
    let f = Fixture::new(0, 0);
    let id = active_claim(&f);

    let err = f.client().try_get_verdict(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimNotResolved);
}

// ── Regression: settlement accounting is unchanged ───────────────────────────

/// Resolving through the versioned entry point moves money exactly like the
/// legacy path: the creator's win pays the creator and leaves challengers
/// nothing to pull.
#[test]
fn versioned_resolution_preserves_creator_win_accounting() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client()
        .challenge_claim(&challenger, &id, &(10 * USDC), &None);
    f.advance_by(3_600);

    let before = f.token().balance(&creator);
    f.client().resolve_claim_versioned(
        &id,
        &Verdict::current(WinnerSide::Creator),
        &f.str("creator wins"),
        &90,
        &f.zero_hash(),
    );

    // Creator staked 10 of 100, so 90 remains; the whole 20 pot comes back.
    assert_eq!(f.token().balance(&creator), 90 * USDC + 20 * USDC);
    assert_eq!(before, 90 * USDC);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.client().get_claim(&id).challenger_claims, 0);
    assert_eq!(f.client().get_platform_stats().resolved, 1);

    let err = f
        .client()
        .try_claim_challenger_payout(&challenger, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ChallengersDidNotWin);
}

// ── Regression: oracle authorization still gates versioned resolution ────────

#[test]
fn versioned_resolution_requires_the_oracle_signature() {
    let f = Fixture::new(0, 0);
    let id = active_claim(&f);
    // No authorizations supplied at all: the oracle's require_auth must fail,
    // exactly as it does on the legacy entry point.
    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_resolve_claim_versioned(
            &id,
            &Verdict::current(WinnerSide::Creator),
            &f.str("unauthorized"),
            &90,
            &f.zero_hash(),
        )
        .is_err());
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);
}
