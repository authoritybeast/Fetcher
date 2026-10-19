# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- Use GitHub's **Report a vulnerability** button (Security tab → Advisories) on this repository.
- Include what you found, how to reproduce it, and what you think the impact is.

You will get an answer within a few days. Please give us reasonable time to fix the problem before you publish details.

## What is in scope

- Ways to make the fetcher request internal or private addresses (SSRF), or follow redirects to them.
- Ways to leak the ingest URL, the ingest token or a vendor API key (logs, error messages, workflow output).
- Ways to make it send data it must not send (for example a description for a source that is not allowed to have one).
- Problems in the GitHub Actions workflows (script injection through inputs, over-broad permissions, unpinned actions).

## What this repository never contains

No secret, token, key, internal URL, project id or customer data is committed here. Everything private comes from GitHub
Actions secrets. If you find something that looks like a secret in the history or in a test fixture, please report it.

The fetcher never handles applicant or job-seeker data: it only reads public job listings.
