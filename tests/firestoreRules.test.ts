import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

describe('Phase 4: Firestore Security Rules & Blueprint Validation', () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');
  const rules = fs.readFileSync(rulesPath, 'utf8');
  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as {
    entities: Record<string, { required: string[]; properties: Record<string, unknown> }>;
    firestore: Record<string, { schema: { $ref: string } }>;
  };

  it('passes @firebase/eslint-plugin-security-rules audit cleanly with zero warnings or errors', () => {
    const res = spawnSync('npx', ['eslint', 'firestore.rules'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(
      res.status,
      0,
      `ESLint security rules check failed:\n${res.stdout}\n${res.stderr}`
    );
  });

  it('defines blueprint collections matching every collection in firestore.rules', () => {
    assert.ok(blueprint.firestore['/users/{uid}']);
    assert.ok(blueprint.firestore['/users/{uid}/downloads/{downloadId}']);
    assert.ok(blueprint.firestore['/users/{uid}/activity/{activityId}']);

    assert.match(rules, /match \/users\/\{uid\}/);
    assert.match(rules, /match \/downloads\/\{downloadId\}/);
    assert.match(rules, /match \/activity\/\{activityId\}/);
  });

  it('enforces default-deny, email verification, PII list denial, immutable fields, and strict allowlists', () => {
    // 1. Default deny catch-all
    assert.match(rules, /match \/\{document=\*\*\}[\s\S]*allow read, write: if false;/);

    // 2. User listing blocked to prevent PII scraping
    assert.match(rules, /match \/users\/\{uid\}[\s\S]*allow list: if false;/);

    // 3. Verified email gate for writes and private subcollection access
    assert.match(rules, /request\.auth\.token\.email_verified == true/);

    // 4. Immutable identity & timestamp anchors
    assert.match(rules, /incoming\(\)\.uid == existing\(\)\.uid/);
    assert.match(rules, /incoming\(\)\.email == existing\(\)\.email/);
    assert.match(rules, /incoming\(\)\.createdAt == existing\(\)\.createdAt/);
    assert.match(rules, /incoming\(\)\.updatedAt == request\.time/);

    // 5. Terminal download states locked & activity log append-only
    assert.match(
      rules,
      /!\(existing\(\)\.status in \['completed', 'failed', 'permanently_failed', 'cancelled'\]\)/
    );
    assert.match(rules, /match \/activity\/\{activityId\}[\s\S]*allow update: if false;/);

    // 6. Strict keys().hasOnly prevents privilege escalation fields (e.g., role, isAdmin)
    assert.match(rules, /data\.keys\(\)\.hasOnly\(\[/);
    assert.match(rules, /'autoRetry'/);
    assert.doesNotMatch(rules, /isAdmin|subscriptionTier|credits/);
  });
});
