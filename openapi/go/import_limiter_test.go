package openapi

import "testing"

// TestImportLimiter_PerUserAndGlobal locks in the availability guarantee: a
// single user can't occupy more than its per-user cap, and the global cap
// bounds everyone — so one user can never starve the others.
func TestImportLimiter_PerUserAndGlobal(t *testing.T) {
	l := newImportLimiter(3, 1) // global 3, per-user 1

	// userA gets exactly one slot; the second concurrent attempt is refused.
	relA1, ok := l.acquire("userA")
	if !ok {
		t.Fatal("userA first acquire should succeed")
	}
	if _, ok := l.acquire("userA"); ok {
		t.Fatal("userA second concurrent acquire must be refused (per-user cap 1)")
	}

	// Other users still get in — userA did NOT starve them.
	relB, ok := l.acquire("userB")
	if !ok {
		t.Fatal("userB should get a slot despite userA holding one")
	}
	relC, ok := l.acquire("userC")
	if !ok {
		t.Fatal("userC should get the third global slot")
	}

	// Global cap (3) now exhausted: a brand-new user is refused.
	if _, ok := l.acquire("userD"); ok {
		t.Fatal("userD must be refused — global cap reached")
	}

	// userA releasing frees a global slot AND its per-user slot.
	relA1()
	relA2, ok := l.acquire("userA")
	if !ok {
		t.Fatal("userA should re-acquire after releasing")
	}

	relA2()
	relB()
	relC()

	// All released → a full fresh set acquires again.
	for _, u := range []string{"u1", "u2", "u3"} {
		if _, ok := l.acquire(u); !ok {
			t.Fatalf("%s should acquire after full drain", u)
		}
	}
}

// TestImportLimiter_ReleaseIdempotent: a double release must not corrupt the
// counters (the controller's deferred release + the service's onDone could
// both fire in error paths).
func TestImportLimiter_ReleaseIdempotent(t *testing.T) {
	l := newImportLimiter(1, 1)
	rel, ok := l.acquire("u")
	if !ok {
		t.Fatal("acquire should succeed")
	}
	rel()
	rel() // second call is a no-op
	rel()

	// Counters are clean: exactly one slot is available, not more.
	if _, ok := l.acquire("u"); !ok {
		t.Fatal("slot should be free after release")
	}
	if _, ok := l.acquire("u2"); ok {
		t.Fatal("global cap 1 must still hold after idempotent releases (no leak)")
	}
}

// TestImportLimiter_EmptyUserGlobalOnly: an unresolved user ("") is bounded by
// the global cap but not per-user (the service 401s these anyway).
func TestImportLimiter_EmptyUserGlobalOnly(t *testing.T) {
	l := newImportLimiter(2, 1)
	r1, ok := l.acquire("")
	if !ok {
		t.Fatal("first empty-user acquire should succeed")
	}
	r2, ok := l.acquire("") // not blocked by per-user cap despite same key
	if !ok {
		t.Fatal("second empty-user acquire should succeed (global cap not yet reached)")
	}
	if _, ok := l.acquire(""); ok {
		t.Fatal("third empty-user acquire must hit the global cap")
	}
	r1()
	r2()
}
