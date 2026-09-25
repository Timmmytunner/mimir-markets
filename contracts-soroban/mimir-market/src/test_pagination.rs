#![cfg(test)]
//! Paginated challenger reads — `get_challengers_page`.
//!
//! Coverage:
//!   positive   – normal page traversal, single-page, last page partial fill
//!   negative   – offset beyond end, claim not found (roster is empty, no error)
//!   boundary   – offset = 0 / total / total-1; limit = 0 / 1 / total
//!   conservation – every roster entry appears exactly once across all pages
//!   regression – existing `get_challenger_list` returns the same items as a
//!                full `get_challengers_page(0, 0)` call

extern crate std;

use soroban_sdk::Vec;

use crate::test_common::{Fixture, USDC};

// ── helpers ───────────────────────────────────────────────────────────────────

/// Add `n` challengers to `claim_id`, each staking 2 USDC.
fn add_challengers(f: &Fixture, claim_id: u64, n: u32) {
    for _ in 0..n {
        let c = f.user(10 * USDC);
        f.client()
            .challenge_claim(&c, &claim_id, &(2 * USDC), &None);
    }
}

/// Create a claim and add `n` challengers. Returns the claim id.
fn setup_claim_with_challengers(f: &Fixture, n: u32) -> u64 {
    let creator = f.user(1_000 * USDC);
    // Stake must cover potential challenger payouts in pool mode; 100 USDC is
    // enough for 100 × 2 USDC challengers at a 2× payout cap.
    let id = f.client().create_claim(&creator, &f.params(100 * USDC));
    add_challengers(f, id, n);
    id
}

// ── positive ─────────────────────────────────────────────────────────────────

#[test]
fn first_page_of_three_returns_correct_slice() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 7);

    let page = f.client().get_challengers_page(&id, &0, &3);
    assert_eq!(page.total, 7, "total should be full roster length");
    assert_eq!(page.offset, 0, "offset should echo the argument");
    assert_eq!(page.items.len(), 3, "page should contain exactly 3 items");
}

#[test]
fn middle_page_returns_correct_slice() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 7);

    let page = f.client().get_challengers_page(&id, &3, &3);
    assert_eq!(page.total, 7);
    assert_eq!(page.offset, 3);
    assert_eq!(page.items.len(), 3);
}

#[test]
fn last_page_is_partial_when_roster_is_not_a_multiple_of_limit() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 7);

    let page = f.client().get_challengers_page(&id, &6, &3);
    assert_eq!(page.total, 7);
    assert_eq!(page.offset, 6);
    assert_eq!(page.items.len(), 1, "only 1 item remains from offset 6");
}

#[test]
fn single_page_covers_entire_roster() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 5);

    let page = f.client().get_challengers_page(&id, &0, &10);
    assert_eq!(page.total, 5);
    assert_eq!(page.offset, 0);
    assert_eq!(page.items.len(), 5);
}

#[test]
fn pages_are_ordered_consistently_with_the_full_list() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 5);

    let full = f.client().get_challenger_list(&id);

    for i in 0u32..5 {
        let page = f.client().get_challengers_page(&id, &i, &1);
        assert_eq!(
            page.items.get(0).unwrap().address,
            full.get(i).unwrap().address,
            "item at offset {i} should match roster position {i}"
        );
    }
}

// ── negative ─────────────────────────────────────────────────────────────────

#[test]
fn offset_beyond_roster_end_returns_empty_items_with_correct_total() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 3);

    let page = f.client().get_challengers_page(&id, &100, &10);
    assert_eq!(page.total, 3, "total is the actual roster size");
    assert_eq!(page.offset, 3, "offset is clamped to total");
    assert_eq!(page.items.len(), 0, "no items beyond the end");
}

#[test]
fn pagination_on_unchallenged_claim_returns_empty_page() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let page = f.client().get_challengers_page(&id, &0, &10);
    assert_eq!(page.total, 0);
    assert_eq!(page.offset, 0);
    assert_eq!(page.items.len(), 0);
}

#[test]
fn pagination_on_nonexistent_claim_returns_empty_page() {
    // No error is raised — the challenger list for an unknown id is just empty,
    // matching the behaviour of the underlying `challengers()` accessor.
    let f = Fixture::new(0, 0);
    let page = f.client().get_challengers_page(&999, &0, &10);
    assert_eq!(page.total, 0);
    assert_eq!(page.items.len(), 0);
}

// ── boundary ─────────────────────────────────────────────────────────────────

#[test]
fn offset_zero_limit_one_returns_only_the_first_entry() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 5);

    let full = f.client().get_challenger_list(&id);
    let page = f.client().get_challengers_page(&id, &0, &1);

    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items.get(0).unwrap().address,
        full.get(0).unwrap().address
    );
}

#[test]
fn offset_equal_to_total_returns_empty_items() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 4);

    let page = f.client().get_challengers_page(&id, &4, &10);
    assert_eq!(page.total, 4);
    assert_eq!(page.offset, 4);
    assert_eq!(page.items.len(), 0);
}

#[test]
fn offset_total_minus_one_returns_single_last_entry() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 4);

    let full = f.client().get_challenger_list(&id);
    let page = f.client().get_challengers_page(&id, &3, &10);

    assert_eq!(page.total, 4);
    assert_eq!(page.offset, 3);
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items.get(0).unwrap().address,
        full.get(3).unwrap().address
    );
}

#[test]
fn limit_zero_returns_all_entries_from_offset() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 5);

    // limit=0 from offset=0 should return everything
    let page = f.client().get_challengers_page(&id, &0, &0);
    assert_eq!(page.total, 5);
    assert_eq!(page.items.len(), 5);

    // limit=0 from offset=2 should return the last 3
    let page = f.client().get_challengers_page(&id, &2, &0);
    assert_eq!(page.total, 5);
    assert_eq!(page.offset, 2);
    assert_eq!(page.items.len(), 3);
}

#[test]
fn limit_exactly_equal_to_remaining_returns_full_tail() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 6);

    let page = f.client().get_challengers_page(&id, &2, &4);
    assert_eq!(page.total, 6);
    assert_eq!(page.offset, 2);
    assert_eq!(page.items.len(), 4);
}

// ── conservation ─────────────────────────────────────────────────────────────

#[test]
fn all_pages_together_reconstruct_the_full_roster() {
    let f = Fixture::new(0, 0);
    let roster_size: u32 = 9;
    let page_size: u32 = 4;
    let id = setup_claim_with_challengers(&f, roster_size);

    let full = f.client().get_challenger_list(&id);
    let mut reconstructed: Vec<crate::types::Challenger> = Vec::new(&f.env);

    let mut offset: u32 = 0;
    loop {
        let page = f.client().get_challengers_page(&id, &offset, &page_size);
        for item in page.items.iter() {
            reconstructed.push_back(item);
        }
        let fetched = page.offset + page.items.len();
        if fetched >= page.total {
            break;
        }
        offset = fetched;
    }

    assert_eq!(reconstructed.len(), full.len(), "page walk must cover every entry");
    for i in 0..full.len() {
        assert_eq!(
            reconstructed.get(i).unwrap().address,
            full.get(i).unwrap().address,
            "entry {i} address must match after reconstruction"
        );
        assert_eq!(
            reconstructed.get(i).unwrap().stake,
            full.get(i).unwrap().stake,
            "entry {i} stake must match after reconstruction"
        );
    }
}

#[test]
fn total_stake_across_all_pages_matches_claim_total_challenger_stake() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 8);

    let claim = f.client().get_claim(&id);
    let mut stake_sum: i128 = 0;
    let mut offset: u32 = 0;

    loop {
        let page = f.client().get_challengers_page(&id, &offset, &3);
        for item in page.items.iter() {
            stake_sum += item.stake;
        }
        let fetched = page.offset + page.items.len();
        if fetched >= page.total {
            break;
        }
        offset = fetched;
    }

    assert_eq!(
        stake_sum, claim.total_challenger_stake,
        "summing stakes across pages must equal the on-chain total"
    );
}

// ── regression ───────────────────────────────────────────────────────────────

#[test]
fn get_challenger_list_and_page_zero_zero_return_identical_items() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 5);

    let full_list = f.client().get_challenger_list(&id);
    let full_page = f.client().get_challengers_page(&id, &0, &0);

    assert_eq!(full_page.total, full_list.len());
    assert_eq!(full_page.items.len(), full_list.len());

    for i in 0..full_list.len() {
        let list_entry = full_list.get(i).unwrap();
        let page_entry = full_page.items.get(i).unwrap();
        assert_eq!(list_entry.address, page_entry.address);
        assert_eq!(list_entry.stake, page_entry.stake);
        assert_eq!(list_entry.claimed, page_entry.claimed);
    }
}

#[test]
fn existing_get_challenger_list_is_unaffected_by_adding_pagination() {
    let f = Fixture::new(0, 0);
    let id = setup_claim_with_challengers(&f, 3);

    // Confirm that the legacy accessor still behaves identically.
    let list = f.client().get_challenger_list(&id);
    assert_eq!(list.len(), 3);
    for entry in list.iter() {
        assert!(entry.stake >= 2 * USDC);
        assert!(!entry.claimed);
    }
}

#[test]
fn claimed_flag_is_reflected_correctly_in_paginated_view() {
    use crate::types::WinnerSide;
    use soroban_sdk::testutils::Ledger;

    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let c1 = f.user(10 * USDC);
    let c2 = f.user(10 * USDC);
    f.client().challenge_claim(&c1, &id, &(2 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(2 * USDC), &None);

    // Advance past the deadline and resolve in challengers' favour.
    f.env.ledger().with_mut(|li| li.timestamp += 3_700);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("challengers win"),
        &80,
        &f.zero_hash(),
    );

    // c1 pulls their payout; c2 does not.
    f.client().claim_challenger_payout(&c1, &id);

    let page = f.client().get_challengers_page(&id, &0, &0);
    assert_eq!(page.total, 2);

    // Find c1 and c2 in the page (order matches insertion order).
    let entry0 = page.items.get(0).unwrap();
    let entry1 = page.items.get(1).unwrap();

    // c1 is first in the roster and has claimed; c2 has not.
    assert_eq!(entry0.address, c1);
    assert!(entry0.claimed, "c1 should be marked claimed after payout");
    assert_eq!(entry1.address, c2);
    assert!(!entry1.claimed, "c2 should still be unclaimed");
}
