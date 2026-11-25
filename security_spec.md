# DOWNLYX Phase 4 Firestore Security Specification

## Data Invariants
1. All collections default-deny unless explicitly matched and authorized.
2. Users may only read, create, update, or delete documents under `/users/{uid}` when `request.auth != null`, `request.auth.uid == uid`, and `request.auth.token.email_verified == true`.
3. `users/{uid}` contains PII (`email`); blanket `allow list` or cross-user `get` is forbidden.
4. Security-sensitive/privilege-escalation fields (`role`, `isAdmin`, `tier`, `plan`, `quotaOverride`, `emailVerified`) are rejected on all writes via strict `keys().hasAll(...)` and `keys().hasOnly(...)` allowlists.
5. Immutable ownership and creation fields (`uid`, `ownerUid`, `email`, `createdAt`) cannot be modified after creation.
6. All creation/update timestamps (`createdAt`, `updatedAt`, `timestamp`) must equal `request.time`.
7. Once a download record reaches a terminal state (`completed`, `failed`, `cancelled`), client updates to that record are rejected (only owner deletion is permitted).
8. Activity log records under `/users/{uid}/activity/{activityId}` are append-only (`allow update: if false;`) and owner-deletable for account removal cleanup.

## Adversarial "Dirty Dozen" Payloads
1. Unauthenticated write to `/users/u1` -> `PERMISSION_DENIED`.
2. Unverified email write (`email_verified: false`) to `/users/u1` -> `PERMISSION_DENIED`.
3. Cross-user read/write (`auth.uid = u2` accessing `/users/u1/downloads/d1`) -> `PERMISSION_DENIED`.
4. Shadow privilege-escalation field (`isAdmin: true` or `role: "admin"`) in `/users/u1` create/update -> `PERMISSION_DENIED`.
5. Spoofed `ownerUid` (`ownerUid: "u2"` while `auth.uid = "u1"`) in `/users/u1/downloads/d1` -> `PERMISSION_DENIED`.
6. Forged client timestamp (`createdAt: "2020-01-01T00:00:00Z"` instead of `request.time`) -> `PERMISSION_DENIED`.
7. Malicious oversized document ID (`id.size() > 128` or path traversal characters) -> `PERMISSION_DENIED`.
8. Oversized URL or note field (`url.size() > 2048` or `note.size() > 500`) -> `PERMISSION_DENIED`.
9. Updating immutable `uid` or `createdAt` on `/users/u1` -> `PERMISSION_DENIED`.
10. Modifying a terminal download record (`status: "completed"` -> `status: "failed"`) -> `PERMISSION_DENIED`.
11. Tampering with an activity log entry (`update` on `/users/u1/activity/a1`) -> `PERMISSION_DENIED`.
12. Querying `list` on `/users` collection or another user's `/users/u2/downloads` -> `PERMISSION_DENIED`.
