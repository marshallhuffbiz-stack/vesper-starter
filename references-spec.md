# Holler references spec

Primary reference, chosen for this app: Apple Messages (iMessage) on iOS 26, with Apple's Human Interface Guidelines for the system chrome. Secondary references: the Grok Bot group room (several agents in one thread, sender names on every run), Telegram bot cards (inline buttons under a bot message), Apple Business Chat list pickers (structured cards inside a thread). Signature rule for AI surfaces (the owner, 2026-08-17): the bots get a distinct, engineered look, never neutral furniture.

## Layout

- Two screens: conversation list and thread. On widths of 900px and up, list on the left (360px) and thread on the right, like Messages on iPad and Mac.
- Safe areas: honor `env(safe-area-inset-*)` everywhere; header sits under the status bar, composer above the home indicator.
- Phone width target 390px (iPhone 15 Pro); must also hold at 375px and 430px with no horizontal scroll.

## Conversation list

- Large title "Holler" at 34px bold, left aligned, collapses into a 17px centered title in a translucent bar on scroll.
- Search pill below the title: 36px tall, radius 10px, magnifier icon, placeholder "Search".
- Pinned grid like iMessage pins: one tile per bot (5 tiles, 3 per row), 76px round avatar, name below at 12px. Unread shows a blue dot on the tile; a bot that is typing shows a small bubble with animated dots above its avatar.
- Rows below: "Team Room" first, then DMs ordered by last activity. Row = 50px avatar (group: cluster of three mini avatars), name 17px semibold, preview 15px secondary color, two lines max, time 15px secondary top right with a chevron, unread blue dot (10px) in the left gutter. Inset hairline separators.

## Thread

- Header: translucent material (`backdrop-filter: saturate(180%) blur(20px)`), back chevron with the unread count in blue at left, centered avatar 40px (group: cluster) with the name below at 11px and a small chevron. Under the name, a live status line in the bot's color when a bot is typing ("Ben is typing").
- Bubbles: 17px text, 22px line height, padding 7px 12px, radius 18px, max width 75%. Sent (you) on the right in iMessage blue (`#0A84FF` dark, `#007AFF` light, a subtle top-to-bottom gradient is welcome) with white text. Received on the left in gray (`#E9E9EB` light with black text, `#262628` dark with white text).
- Runs: consecutive bubbles from one sender sit 2px apart, a new sender starts 8px down. Only the last bubble of a run has a tail (classic iMessage tail drawn with pseudo-elements). In the room, the sender's first name sits above the first received bubble of a run (12px, secondary), and the sender's avatar (28px) sits beside the last bubble of the run.
- Time separators: when 15 minutes or more pass between messages, a centered label "Today 2:14 PM" at 12px, day part semibold, secondary color.
- Receipts: under the owner's last message, right aligned 11px "Delivered", or "Read 2:15 PM" when the bot has read it.
- Typing: a received gray bubble with three dots that pulse in sequence, plus the two small trailing tail circles iMessage uses.
- Long press (450ms) on a bubble: the bubble lifts and scales slightly, everything else dims and blurs, a tapback bar appears above it (❤️ 👍 👎 😂 ‼️ ❓) and a small menu below (Reply, Copy). A chosen tapback shows as a small badge on the bubble's top corner.
- Swipe a bubble to the right to reply; the composer shows a "Replying to Ben" bar with the quoted text and an X. Replies show a small quoted preview above the bubble.
- Cards (bot messages with buttons, e.g. a Hermes approval): a received bubble with full-width stacked buttons under the text, separated by hairlines, blue text, red text for `danger`, like an iOS action sheet inside the bubble. Once resolved, the buttons collapse into a single line "Approved by the owner" with a check.
- Images: rounded 18px, max 240px wide, tap to view full screen.
- Markdown in bot messages: bold, italics, inline code, fenced code (monospace block with a slightly darker fill, horizontal scroll inside the bubble), links (underlined, open in a new tab), bulleted and numbered lists. Escape all HTML.

## Composer

- Bottom bar on the translucent material. A 34px round "+" button on the left (attach photo), then a pill text field (1px border, radius 18px, placeholder "Message"), growing to 6 lines then scrolling. When the field has text, a 30px blue round send button with a white up arrow sits inside the right end of the field.
- In the room, typing "@" opens a small mention picker of the bots (avatar + name); choosing inserts "@Ben ".
- Enter sends on desktop, Shift+Enter is a new line; on phones the return key inserts a new line and the send button sends.

## Bot signature

Each bot has a locked gradient used on its avatar (monogram initials, white, SF Rounded weight 600), its name label, typing dots and status line:

| Bot | Gradient |
|---|---|
| Ada (Ops) | `#B15CFF` to `#6E3BFF` |
| Ben (Acme, Birch, Cedar) | `#2FD3C6` to `#0E8FD6` |
| Cleo (Dune, Ember) | `#FFB547` to `#FF6A3D` |
| Dora (Fjord) | `#7BE07A` to `#1FA65A` |
| Eli (Leads) | `#FF7A8A` to `#D6334F` |

An online dot (green, 12px with a 2px background ring) on the avatar when that bot's Hermes connection is live. the owner's own bubbles stay iMessage blue.

## Type and color

- Font stack: `-apple-system, "SF Pro Text", system-ui, sans-serif`; rounded numerals and monograms with `ui-rounded`.
- Light: background `#FFFFFF`, secondary text `#8E8E93`, separators `rgba(60,60,67,.29)`, grouped fill `#F2F2F7`.
- Dark: background `#000000`, secondary text `#8E8E93`, separators `rgba(84,84,88,.6)`, fill `#1C1C1E`.
- Follow `prefers-color-scheme`.

## Motion

- New incoming bubble: rises 8px and fades in over 220ms with a slight overshoot (`cubic-bezier(.2,.9,.3,1.2)`).
- Sent bubble: grows from the composer's right edge, 260ms.
- Screen push and pop: 350ms slide with the iOS curve (`cubic-bezier(.32,.72,0,1)`); edge swipe from the left goes back.
- Respect `prefers-reduced-motion`.
