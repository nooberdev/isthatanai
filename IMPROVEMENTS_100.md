# 100 improvements that would make isthatanai better

A pragmatic backlog for the next releases. These are **not implemented**; they are
ideas ranked by the value they would bring to developers, integrators and end
users. Anything that would violate the privacy contract (network, storage,
fingerprinting, key/text identities) is deliberately excluded.

## Release and distribution (1–12)

1. **Publish v0.1.0 to npm** with provenance and a signed tag; the package is ready but the token is missing.
2. **GitHub Releases** with generated notes and attached IIFE bundles for people who do not use npm.
3. **CHANGELOG.md** with Keep-a-Changelog format, generated from conventional commits.
4. **CONTRIBUTING.md** explaining workspace layout, the zero-weight measure pattern and the eight pinned scores.
5. **CODE_OF_CONDUCT.md** and a clear governance statement for a public project.
6. **SECURITY.md** already exists; add a `security@` contact and a disclosure SLA.
7. **CI matrix** for Bun on Linux, macOS and Windows, plus Node 20/22 consumer smoke tests.
8. **Reproducible builds** with pinned toolchain and byte-for-byte bundle verification in CI.
9. **Size budget CI** that fails when IIFE exceeds 250 KB unless explicitly approved.
10. **Semver policy** documented: thresholds are API, score changes require a major version.
11. **Migration guide** template for future breaking releases, started with 0.x → 0.1 notes.
12. **Release checklist** script that runs `bun run verify` plus npm/GitHub dry runs.

## Developer experience (13–32)

13. **Interactive API playground** in `/docs` with editable options and live verdict output.
14. **StackBlitz / CodeSandbox starter** for React, Svelte, Vue and plain HTML.
15. **CLI** (`bunx isthatanai`) to inspect a recorded JSON session and print scores and reasons.
16. **Trace inspector** that renders a session timeline with samples, scores and verdict transitions.
17. **Debug overlay** toggle showing active signals, EMA, thresholds and guardrail risk in the host page.
18. **Deterministic seed injection** public API for reproducible demos and tests.
19. **Fixture recorder** that produces anonymized sessions directly from the demo with one click.
20. **Golden-file tests** for score outputs across all locales and device profiles.
21. **Coverage report** published with thresholds for new measures.
22. **Mutation testing** on scoring math to catch threshold regressions.
23. **VS Code extension** with snippets, API hover docs and a session viewer.
24. **Codemod** for renaming options between versions.
25. **Devcontainer** with Bun, Chrome and Playwright preinstalled.
26. **Nix flake** for reproducible development environments.
27. **Windows parity scripts** (`*.cmd`) for every root shell helper.
28. **Node.js consumer test** proving the ESM bundle works outside Bun.
29. **Bundle explorer** page showing which module contributes each KB.
30. **Typed option presets** exported as constants (`PRESET_STRICT`, `PRESET_TV`, etc.).
31. **Zod-free runtime validation report** that explains which option was rejected and why.
32. **Error codes** instead of raw strings for invalid configuration, with docs links.

## Detection quality (33–56)

33. **Real agent sessions** from Playwright, browser-use and browser vendors, clearly separated from simulations.
34. **Server-side verifier** companion package for cross-session replay and integrity checks.
35. **Challenge/response liveness** that cannot be answered without genuine event timing.
36. **Cross-session replay detection** when a server is available, with privacy-preserving hashes.
37. **Drift detection** that notices when a site's user population changes and re-calibrates safely.
38. **Per-device threshold profiles** validated with real laptop, tablet, phone and TV users.
39. **Per-locale typing baselines**, since keyboard layout changes rhythm and bigram timing.
40. **Accessibility profiles** for switch devices, screen readers and eye trackers, with explicit consent.
41. **Low-end device profile** for coarse pointers and throttled event loops.
42. **High-refresh-rate support** for 120/240 Hz mice and trackpads.
43. **Remote desktop / VNC detection** as a distinct session type rather than an AI verdict.
44. **Gaze proxy** via pointer hover before action, validated on real data.
45. **Dwell-time model** for touch and pen, replacing simple duration thresholds.
46. **Pressure normalization** across device classes for touch measures.
47. **Sensor fusion** for touch + orientation where the platform exposes it numerically.
48. **Fatigue curve** validated over long sessions rather than synthetic ramps.
49. **Fitts-law calibration** with real target sizes and distances from the host page.
50. **Text-entry intent model** that distinguishes paste, autofill, dictation and IME safely.
51. **Error-recovery taxonomy** distinguishing typo correction from selection-based editing.
52. **Coherence graph** replacing pairwise surprise checks with a small temporal graph.
53. **False-positive dashboard** for integrators, computed locally and exported, never uploaded.
54. **Adversarial evaluation suite** with published evasion results, refreshed quarterly.
55. **Humanization-resistance score** describing how much jitter would be needed to evade, as a research metric.
56. **Confidence calibration** verified with reliability diagrams on real sessions.

## Privacy and security (57–76)

57. **Strict DNT mode** that also disables debug logging and detailed reasons.
58. **Aggregates-only mode as an option in the demo UI**, not just the API.
59. **Data-flow diagram** in the docs showing exactly what leaves the collector.
60. **Automated privacy scan** in CI asserting absence of fetch/XHR/storage/cookies in the library.
61. **Key-identity scan** in CI asserting no `event.key`/`event.code` values reach samples.
62. **Threat model reviews** on every major release, with versioned SECURITY notes.
63. **Subresource Integrity hashes** published for the IIFE bundle.
64. **CSP guidance** for hosts embedding the script tag and custom event.
65. **Iframe sandbox guidance** for untrusted third-party content.
66. **Worker isolation experiment** to keep scoring off the main thread where supported.
67. **Tamper-evident config snapshots** in `getScoreBreakdown()` for host-side auditing.
68. **Integrity callback** so a host page can react when a check fails.
69. **Liveness heartbeat event** with timestamps a server could optionally verify.
70. **Bug bounty programme** with clear scope and safe-harbour language.
71. **Adversarial ML review** by an external team once a year.
72. **Dependency-free guarantee test** in CI (no runtime dependencies added silently).
73. **Immutable build artifacts** with checksums in the release notes.
74. **Reproducible IIFE global test** in a real browser, not only Node.
75. **Privacy notice localization** in all twelve languages (currently Spanish only in the constant).
76. **Consent UX recipe** for pages that want to explain local-only detection to users.

## Demo and documentation (77–92)

77. **Docs search** with a local index; no network, no storage.
78. **Versioned docs** so `/docs/v0.1` stays stable after future releases.
79. **API explorer** that generates code from selected options.
80. **Interactive verdict simulator** with sliders for score, thresholds and confirmation time.
81. **Video walkthrough** of the lab and the honest detection table.
82. **Screenshot gallery** of the demo in all twelve locales and both themes.
83. **Keyboard-only audit** of the docs and demo with published results.
84. **Screen-reader audit** with VoiceOver/NVDA notes.
85. **Localization completeness checker** that fails CI when a dictionary key is missing.
86. **Native-speaker review** of the twelve dictionaries, especially ja/ko/zh.
87. **Printable API reference** as a single page.
88. **Examples gallery** with real host pages: blog comment form, checkout, admin panel.
89. **Recipe for Next.js** and one for plain Vite, with SSR notes.
90. **Troubleshooting wizard** that maps symptoms to settings (measuring, false AI, slow verdict).
91. **Benchmarks page** showing first-verdict latency per device class.
92. **Glossary** of EMA, hysteresis, confidence, doubt, guardrail and fail-closed.

## Community and long-term health (93–100)

93. **Public roadmap** derived from this file, with status and target versions.
94. **Good-first-issue labels** and templates for adding a measure to a zero-weight table.
95. **Community translation workflow** with clear review ownership per locale.
96. **Research paper / technical note** describing the scoring model and laboratory methodology.
97. **Reproducibility scripts** for the lab report, so anyone can regenerate the honest table.
98. **Dataset licensing review** for the public references cited in `external-reference.ts`.
99. **Browser compatibility matrix** with tested versions and known limitations.
100. **Six-month review ritual**: revisit the eight pinned scores, the threat model and the honest limitations together.
