# Contributing

Thank you for improving Groq Dictation Kit.

## Development

Requirements:

- Node.js 20 or newer
- npm 10 or newer

```bash
npm ci
npm test
```

To run the local benchmark app, place `GROQ_API_KEY` in an ignored `web/.env` or root `.env` file and run:

```bash
npm run dev
```

## Pull requests

- Keep API changes backward-compatible within a minor release.
- Add or update tests for behavioral changes.
- Never commit API keys, recordings, transcripts, `.env` files, or npm tokens.
- Run `npm test` and inspect `npm pack --dry-run` before requesting review.
- Explain user-visible changes and any privacy or latency tradeoffs.

## Releases

Releases use semantic versions. Update `CHANGELOG.md`, run the complete test suite, inspect the package tarball, and verify that no secrets or local artifacts are included before publishing.
