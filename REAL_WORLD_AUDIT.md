# Real-world audit — all 205 checklist items

This document records the one-by-one verification pass over every item in
`checklist.txt`. Each area was reviewed by its own lane, which read the
implementation, built a realistic use case, asserted the numeric result, and
fixed any defect found in place. The pinned laboratory scores did not change.

## Method

- **Realistic scenarios, not toy discriminators.** Human traces were generated
  with Fitts-like approaches, deceleration, overshoot and fine correction;
  variable WPM paragraphs with corrections and thinking pauses; natural drag,
  double-click and wheel-scroll patterns; touch taps/swipes/pinches dispatched
  through the real collectors; and visibility/focus/resize/idle event streams.
  Attack traces used fixed 7–16 ms cadences, linear paths, uniform jitter,
  sawtooth humanization, webdriver hints, exact replays and tampered clocks.
- **One assertion per item minimum**, plus edge cases: NaN/Infinity/1e308,
  zero-dt coalesced bursts, out-of-order timestamps, hostile Proxy getters,
  SSR imports, listener leaks and large sessions.
- **Fail-closed checks.** Insufficient evidence, failed integrity and hostile
  configuration must never produce a human verdict.

## Coverage and fixes

| Area                                 | Items                | Test file                                      |   Tests | Fixes                                                                         |
| ------------------------------------ | -------------------- | ---------------------------------------------- | ------: | ----------------------------------------------------------------------------- |
| Mouse                                | L2–L52               | `tests/real-world/mouse.test.ts`               |      56 | L3, L4, L7, L9, L42 fixed; L11 added                                          |
| Click + scroll                       | L54–L68, L104–L112   | `tests/real-world/click-scroll.test.ts`        |      34 | L61, L67 added                                                                |
| Keyboard                             | L70–L102             | `tests/real-world/keyboard.test.ts`            |      38 | L76, L77, L80, L86, L91, L92 fixed                                            |
| Touch + attention                    | L114–L123, L125–L135 | `tests/real-world/touch-attention.test.ts`     |      23 | L116, L131–L134 fixed                                                         |
| Coherence + environment + anti-cheat | L137–L154, L210–L217 | `tests/real-world/core.test.ts`                |      30 | L215 fixed                                                                    |
| Scoring + API + privacy              | L159–L208            | `tests/real-world/system.test.ts`              |      55 | L184 fixed                                                                    |
| Demo/tools                           | L219–L225            | `apps/demo/build/index.html`, component traces | 7 paths | Recording summary, recalibration payload, three unreachable sections, styling |

Total: **236 new real-use-case assertions/tests**, 21 library defects fixed.

## Defects found and fixed

1. **L3/L4 mouse** — sub-pixel jitter at rest counted as curvature and direction changes. Added a 15 % micro-step noise floor.
2. **L7 mouse** — coalesced `dt <= 0` steps poisoned the median and created false large jumps. Excluded before median.
3. **L9 mouse** — zigzag threshold was absolute pixels, so 4× zoom broke it. Now relative to median step length.
4. **L11 mouse** — no measure for exact trajectory repetition. Added `mouseExactRepetition()` (opt-in, zero weight).
5. **L42 mouse** — any reversal scored 1 because all excursions were summed. Replaced with a real backtrack fraction.
6. **L61 click** — no "time to first click" measure. Added `clickFirstClickLatency`.
7. **L67 click** — no "consecutive click speed" measure. Added `clickConsecutiveSpeed`.
8. **L76 keyboard** — thinking pauses made hand-switching look robotic. Cognitive pauses are trimmed before measurement.
9. **L77 keyboard** — category repetition ignored chance level. Now measures excess over expected repetition.
10. **L80 keyboard** — warm-up acceleration counted natural pauses. Cognitive pauses are trimmed.
11. **L86 keyboard** — rhythm-by-text-length counted pauses. Cognitive pauses are trimmed.
12. **L91 keyboard** — no Shift+Arrow evidence always scored 1. Now derives from backspace share.
13. **L92 keyboard** — flagged editing without arrows even with no edits. Now requires ≥15 % edits.
14. **L116 touch** — `rotationAngle === 0` means "no sensor", not "constant tilt". Missing data is now neutral.
15. **L131–L134 attention** — reaction/reading/fatigue were measured against `focus`, which fires ~10 ms after visibility changes; every real reader scored 1. Now measured against real user actions only.
16. **L215 anti-cheat** — uniform humanization jitter was quantized to 1 ms, collapsing float noise; now 0.1 ms.
17. **L184 API/i18n** — `configure({ locale })` left reasons in the old language. Reasons are stored canonically and re-translated.
18. **Demo L219/L220** — stale recording summary/export; whole nested session passed to recalibration, producing `samples: 0`. Session payload is now flattened.
19. **Demo L221/L222/L223/L225** — four sections were mounted but invisible (missing `section` class). Fixed with correct wrappers and styling.

## Backward compatibility

Every fix lives in an opt-in or zero-weight measure, an additive guardrail field,
or a localization/render path. The eight pinned laboratory scores remain:

`0.1580`, `0.2199`, `0.0448`, `0.1481`, `0.5813`, `0.7857`, `0.1369`, `0.1785`.

## Validation

```text
bun test                  → 851 pass, 0 fail (316119 assertions, 49 files)
bun run typecheck         → exit 0 (library + demo, 0 errors/0 warnings)
bun run lint              → exit 0, 0 errors (3 pre-existing demo warnings)
bun run build             → exit 0 (ESM + IIFE + global IIFE + declarations)
bun run --filter=demo build → exit 0 (SSR + client + prerender OK)
bun tools/check-bundle.ts → IIFE 200.61 KB / ESM 351.83 KB, OK
```

The documentation page at `/docs` was additionally checked in headless Chrome
at 1440×1000, 820×1180 and 390×844 in both themes: no horizontal overflow,
active anchor state correct, contrast ≈7.6:1 dark and ≈4.7:1 light. The Impeccable
mechanical detector returned `[]`.
