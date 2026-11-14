# iOS 26/27 Messages: measured spec (research 2026-10-27)

Source: research pass over Apple's iOS 27 iPhone User Guide screenshots (measured at 1.133 px/pt, light mode), Apple HIG (materials, color, toolbars), MacRumors/MacStories/9to5Mac iOS 27 coverage. [A] = stated by a source, [M] = measured from Apple screenshots, [E] = estimate. iOS 27 kept the iOS 26 Liquid Glass layout; it added a glass transparency slider, darker glass edges, a more even top scroll band, and per-item send progress.

## List
- Background #FFFFFF / #000000. No bar: floating glass "Edit" capsule (~62x44, 16pt from left) and filter circle (44pt, 16pt from right), ~56pt from top, black glyphs [M].
- "Messages" 34pt bold, 16pt left; collapses to centered 17pt semibold on scroll [M].
- Search lives at the BOTTOM: glass capsule ~48pt tall with magnifier, "Search", mic; compose is a separate 48pt glass circle bottom right; ~28pt above the screen edge [A][M].
- Pins: 88pt circles, 3 columns 128pt apart, name 11-12pt gray below, unread = 10pt blue dot before the name, latest message as a small white bubble on the circle's upper right [M].
- Rows ~87pt (two preview lines always reserved); avatar ~46pt at x≈25; unread dot 10pt #0088FF at x≈7; text at x≈83; name 17 semibold; preview 15 regular ~#6C6C70, 2 lines, 20pt pitch; time 15 gray + light chevron 16pt from right; hairline #E8E8E9 from x≈83 [M].

## Thread
- No bar: back = 44pt glass circle (black chevron), FaceTime = 44pt glass circle, ~56pt from top, 16pt insets. Centered 60pt avatar, then a 32pt glass name capsule overlapping it ~5pt, 17pt semibold name + small gray chevron [M].
- Content under the top ~150pt blurs and fades progressively (iOS 27: more even, more opaque band) [M][A].
- Glass light: fill ~#F8F8F8-#FAFAFA, rim ~#DFDFDF, bright top highlight, shadow 2-6pt down, 10-16pt blur, 6-10% black. Dark: ~rgba(30,30,32,.6), white rim ~15% [M][E].
- Compose: "+" glass circle ~40pt at 27pt from left; separate glass field capsule ~40pt tall, 12pt gap, ends 28pt from right; placeholder 17pt ~#B7B7BA "iMessage"; send = wide blue capsule (~34x28) with white up arrow; bar ~29pt above screen edge, 8-16pt above the keyboard when open [M][A][E].

## Bubbles
- SF Pro 17 regular, ~20.5pt line pitch; one-line bubble 40pt tall (pill); padding ~9.5 vertical, ~14 horizontal; radius ~18; max width ~72% of screen [M][E].
- 1:1 chats: bubbles 16-17pt from the edge. Groups: 30pt avatar at x=16 aligned to the last bubble of a run; bubbles start ~56pt; sender name 11-12pt gray above the first bubble of a run [M].
- Tail only on the last bubble of a run; curled hook ~10pt wide, tip ~6pt below the bubble [M].
- Spacing ~3pt within a run, ~10pt between senders [M].
- Received #E9E9EB / black text (dark ~#262628 / white). Sent blue is a SCREEN-TIED gradient: #5EC6FA at the top, #45B6FC at 230pt, #259DFD at 530pt, #0F8FFE at 700pt, #0088FF from 790pt down (bubbles change color as they scroll). Dark system blue #0091FF [M][A].
- Centered timestamps "Today 7:00 AM" ~12pt gray, day semibold; after long gaps (~1 hour) [M][E].
- Receipts only under the newest sent bubble, ~12pt gray: "Delivered" or "Read 9:15 AM" ("Read" semibold); "Delivered • Edited" with Edited in blue [A][M].
- Reaction badge ~30pt circle at the bubble's upper outer corner with two shrinking dots toward the bubble [M].

## Interactions
- Long press / double tap: background DIMMED, not blurred (white → ~#E5E5E5); pressed bubble stays bright and lifts. Tapback bar = glass capsule ~62pt tall, 44pt items ~49pt apart: pink heart, yellow thumbs up, orange thumbs down, blue "HA HA", red "!!", purple "?", then emoji; current choice in a filled blue circle. Glass menu: Reply, Edit, Undo Send, Copy, Select, Translate, More [A][M][E].
- Swipe right on a bubble = Reply (arrow fades in, commits ~60pt) [A][E].
- Drag left = timestamps: SENT bubbles slide up to ~70pt with resistance, received stay; times ~12pt gray right-aligned 16pt from the edge; spring back ~0.35s, no overshoot [A][E].
- Typing: gray bubble ~48x36 with three 8pt dots, opacity .4→1, 1.2s loop, .2s stagger; tail = two small circles [E].
- Incoming message pops from its tail corner (scale .85→1, ~0.35s spring); sending rises from the field [E].
- Rubber-band bounce at scroll ends; compose bar rides the keyboard (visualViewport) [E].

## Navigation
- Push ~0.5s, no bounce (cubic-bezier(.32,.72,0,1)); list moves ~30% left and dims ~10%; soft shadow on the thread's left edge; moving screen gets display-matched rounded corners during the transition [E][A].
- Edge swipe follows 1:1; completes past ~50% or on a flick > ~500pt/s, else springs back [E].

## Tells of a copy
Flat #007AFF; tails on every bubble; 36pt bubbles; blue toolbar text or one full-width blurred header; search at the top; blurring on long press; monochrome tapbacks; receipts on every message; non-SF font; no rubber band; composer not attached to the keyboard; too-light dark-mode received bubbles.
