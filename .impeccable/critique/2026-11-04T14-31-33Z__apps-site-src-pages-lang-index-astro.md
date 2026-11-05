---
target: landing page apps/site
total_score: 23
max_score: 36
na_heuristics: 7
p0_count: 1
p1_count: 2
target_identity: "file:/home/benataz02/dev/confire/apps/site/src/pages/[...lang]/index.astro"
target_fingerprint: "sha256:dd984986cdc1de2ae89dc7f2d13ae4bc311c14ee61f7cdfb50d0dd71862c1510"
target_path: /home/benataz02/dev/confire/apps/site/src/pages/[...lang]/index.astro
timestamp: 2026-11-04T14-31-33Z
slug: apps-site-src-pages-lang-index-astro
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Demo submit awaits the mail with no pending/disabled state |
| 2 | Match System / Real World | 4 | Speaks SAP B1/Beas vocabulary exactly |
| 3 | User Control and Freedom | 2 | /demo-error/ "Back to the form" returns an empty form |
| 4 | Consistency and Standards | 3 | "Book a demo" ×8 vs "Request a demo" submit |
| 5 | Error Prevention | 2 | Browser bubble only; no :user-invalid field state |
| 6 | Recognition Rather Than Recall | 3 | Clear sections; bento has no path back to CTA |
| 7 | Flexibility and Efficiency | n/a | Persuade surface, one linear task |
| 8 | Aesthetic and Minimalist Design | 3 | Restrained; mobile stage ~1,500px |
| 9 | Error Recovery | 1 | /demo-error/: no contact, run-on copy, data lost |
| 10 | Help and Documentation | 3 | FAQ does the job; two answers start "Draft:" |
| **Total** | | **23/36** | **Acceptable (64%)** |

## Priority issues
1. [P0] Placeholder/Draft copy live on page and in FAQPage JSON-LD (en.ts:78,178,181).
2. [P1] Demo-error path loses the request; missing space "us.Please"; SITE.contactEmail empty.
3. [P1] No proof or identity anywhere (who is behind Confire).
4. [P2] Evening: security band = page bg (#12171c) and dissolves; stage/CTA/tile shadows mix --sapTitleColor (near-white in dark) → grey smears (landing.css:27,144,238).
5. [P2] Stage (the pitch) starts below the 900px fold on desktop; ~1,500px on mobile.

## Minor
- Contrast: .why uses --sapCriticalElementColor as text 3.1:1; .st-inf 3.6:1; .st-crit 4.1:1; dark placeholder 3.7:1 unstyled.
- Tap targets <44px: shell CTA 36, menu 50×36, footer links 16 tall.
- Eyebrows ×6 flagged (kicker-above-heading) but pinned by spec §5.3.
- Setup select preselects "SAP Business One" (skews leads).
- "Works with" uses Positive status dots for compatibility.
