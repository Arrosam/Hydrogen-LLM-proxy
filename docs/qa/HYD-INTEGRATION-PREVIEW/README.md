# Aggregate preview verification

This directory identifies the combined preview's verification contract. The final execution report and raw logs are stored in the sibling task `evidence/` directory, outside the application and Docker build context. That report pins the exact combined commit and distinguishes final passes from intermediate failures and unrun remote actions.

## Included scope

The aggregate card is `docs/feature-integration-preview.md`. Source cards cover server-tool policy, hosted-tool combobox, live discovery and strict mismatch fallback, including OCR/ASR and durable pending adapters. The policy head also includes shared parameter override fieldset styling. F002 model filtering is excluded.

## Reproduced integration failures

- The policy test still expected checkbox selection after the combobox integration; it now exercises existing-ID combobox selection/removal and keeps the original declaration and persistence assertions.
- The SDK initialization test hardcoded the previous release version; it now checks the current package version.
- CA-01: response synthesis used a bare provider ID to suppress client calls or conflate separate local receipts. Red regressions and independent actual-controller reproduction preceded the private-instance matching correction.
- CA-02: a private local receipt discharged a distinct same-batch client call with a reused ID. Red HTTP regressions in both protocols and JSON/SSE preceded the private-receipt exclusion in saved continuation validation.
- Narrow browser review found clipped modal actions and a flipped popup hiding the binding-limit error. Responsive wrapping and library-controlled popup closure address those observations; pointer/keyboard rejection tests preserve atomic IDs and the query.

## Final acceptance record requirements

Run root server/web/release tests, typecheck, build, strict synthetic fixture checks, real HTTP mismatch scenarios, official MCP SDK scenarios and cross-feature HTTP/SDK routing/snapshot cases on the final commit. Obtain independently pinned code and ISTQB reviews and real desktop/narrow browser validation of final assets. Record local preview container build/smoke separately. Compare dependency resolution/integrity and fresh audit output to the release baseline. Capture preview package/tag/release/image isolation and unchanged original branch heads.

Five existing high audit findings currently block the publication workflow. No dependency gate is waived. Remote publication, production deployment, paid models, production data and historical snapshotless-session acceptance remain outside this completed local phase or explicitly unresolved.
