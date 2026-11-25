# Security policy

## Reporting a vulnerability

Please report suspected security vulnerabilities privately through GitHub's
**Security** tab using **Report a vulnerability** (private vulnerability
reporting), if available. Do not publish exploit details or personal data in
a public issue.

Include the affected component, impact, reproduction steps, and any relevant
logs with secrets removed.

## Firebase client configuration

The Firebase web API key is client-side configuration and is visible in the
browser bundle. It is not an authorization credential by itself. Keep it
restricted in Google Cloud to the Firebase APIs this application requires,
and never allowlist the Gemini Developer API or unrelated billable APIs on
a publicly exposed Firebase key.

Firestore and Storage access must be protected by Firebase Security Rules.
Use App Check where supported and appropriate.

## Server-side secrets

Never commit Gemini Developer API keys, Firebase service-account private keys,
OAuth client secrets, signing keys, or other server credentials. Store them
in deployment secret settings or a local environment file excluded by Git.

## Secret remediation

If a real secret is committed:
1. Revoke or rotate it with its provider immediately.
2. Update the deployment to use the replacement.
3. Remove the exposed value from the current source.
4. Review and clean Git history where appropriate.
5. Confirm the provider's audit/activity logs for unexpected use.
