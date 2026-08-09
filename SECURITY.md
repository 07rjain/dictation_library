# Security Policy

## Supported versions

Until version 1.0, security fixes are applied to the latest published minor version.

## Reporting a vulnerability

Please do not open a public GitHub issue for a vulnerability involving credential exposure, arbitrary file access, authentication bypass, or private audio/transcript disclosure.

Use GitHub's private vulnerability reporting feature for this repository. Include reproduction steps, affected versions, impact, and any suggested mitigation. Please allow maintainers reasonable time to investigate before public disclosure.

## Credential and data handling

- Groq and npm credentials must remain in environment variables or ignored `.env` files.
- Shared Groq keys must never be embedded in browser bundles.
- Applications using this package are responsible for authentication, rate limiting, consent, retention, and deletion policies.
- Audio, transcripts, screen context, and custom vocabulary should be treated as potentially sensitive user data.
- The included benchmark server is intended for local development, not unauthenticated public deployment.
