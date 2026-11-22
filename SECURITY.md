# Security Policy

If you find a security issue in this project, please email **support@everhostx.com**.

Please do not open a public GitHub issue for vulnerabilities, and do not include seeds, tokens, or other secrets in the report.

## Scope notes

This game is built for XRPL **test networks only**. The default is devnet; testnet is selectable; **mainnet is always refused**. Never reuse a test-network seed or key on mainnet, and never send real funds to a test account.

World state under `DCH_DATA_DIR` (default `.data/`) holds throwaway test-network seeds. Keep that directory private (mode 0700), never commit it, and never back it up in a public place.
