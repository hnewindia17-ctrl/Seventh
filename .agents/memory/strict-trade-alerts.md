---
name: Strict trade alerts
description: The trading terminal's alert surface must stay confirmation-first and never promote partial confluence into an actionable signal.
---

The alert engine must keep an all-gates policy: missing, disabled, stale, or contradictory indicator data means scanning or blocked state, never a modal.

**Why:** The user explicitly requires zero alerts on partial matches across order flow, delta, DOM, pressure, absorption/iceberg, and both cumulative candle studies.

**How to apply:** Any future alert-criteria change should add evidence to the evaluator and preserve the explicit gate check; do not replace it with a weighted score threshold.