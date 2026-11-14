# iOS 27 Messages motion, measured from a screen recording (2026-10-27)

Source: `tmp/recording/ref.mov` (36 s, 1180x2556, ~60 fps capture, 1 px = 1/3 pt). Measured with per-frame pixel diffs (bounding box of changed pixels, changed-pixel count per frame) at 393x852 and 50 ms contact strips. Frame times are +-17 ms. The capture drops to ~20 fps during the details morph, so those numbers are +-50 ms.

## Numbers
| Interaction | Start to settled | Shape |
|---|---|---|
| Keyboard up (2.68 s) | 370 ms | fast start, long decel; composer and thread move with it in the same frames, no gap |
| Keyboard down (9.07 s) | 380 ms | same curve reversed |
| "+" menu open (15.01 s) | 450 ms (90% by 200 ms) | grows from the "+" button, origin bottom-left; "+" swells first (50 ms), then a glass blob, then the full panel; ~2 pt overshoot at 250-300 ms |
| "+" menu close (16.59 s) | 200 ms (bulk in 100 ms) | shrinks back into the "+", no overshoot |
| Details open (25.75 s) | ~550 ms (full size by ~250 ms) | name capsule becomes a glass card that grows uniformly from the header; content inside is the details screen scaled with it; inner content settles ~8 pt upward until ~550 ms |
| Details close (edge swipe, 31.15 s) | ~550 ms | screen shrinks to a rounded card that follows the finger (scale ~0.9 to ~0.4) and moves right, then flies off right; thread behind is not dimmed |
| Pop to list (edge swipe, 35.23 s) | finger-ember, finish 250 ms | thread follows 1:1; list parallax from ~-30%; no visible dim at this exposure |

## "+" menu (settled, pt)
- Panel x 10 to 330 (320 wide), top ~352, bottom ~805: it covers the "+" and the left of the field; radius ~32.
- Rows 66 pt pitch; icon 38 pt circle centered at x 64; label 22 pt regular at x 109.
- Material: frosted white, heavy blur of the bubbles behind it (text behind is unreadable). The rest of the thread is NOT dimmed or blurred.

## Details screen
- Back glass circle top-left (same as thread), "Edit" right (omitted in Holler).
- Avatar ~100 pt centered at y ~140, name 28 pt bold below with heart, round action buttons (~44 pt glass), segmented control, grouped cards with ~26 pt radius.
- Thread behind stays undimmed during the morph.

## Other differences found and fixed in pass 3
1. Send is a blue CIRCLE (~30 pt) with a white arrow, not a wide capsule.
2. The "+" menu frosts only what is behind the panel; no full-screen dim.
3. Header stays crisp while scrolling; bubbles blur and fade under it (already matched).
4. Details close by edge swipe shrinks the screen as a card instead of sliding it.

## Not measurable from this recording
- Exact keyboard curve (system; the web app follows `visualViewport`).
- List dim during pop (below the noise of the moving list).
- Unread pill and "Delivered" timing: no unread change and no send happen in the clip.
