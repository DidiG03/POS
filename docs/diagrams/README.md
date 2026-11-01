# OneTap POS diagrams

How the POS works, drawn from the code. Made for reading on an iPad
(Freeform, Files, Books) or on screen.

| # | Diagram | Answers |
|---|---|---|
| – | `00-key.html` | Key (colours, shapes, lines) and glossary. Read this first |
| 1 | `01-system-map` | Which apps exist and how they connect (till, Waiter, Admin, KDS, printers, easyPos, billing) |
| 2 | `02-order-lifecycle` | Sign in → order → Send → kitchen → pay → closed table |
| 3 | `03-payment-fiskalizimi` | Everything that happens when someone taps Pay |
| 4 | `04-data-model` | What the till stores and how the tables relate |
| 5 | `05-signin-security` | Sign-in on the till vs phones, lockouts, roles, approvals, encryption |
| 6 | `06-shifts` | Clocking in and out, and the shift summary slip |
| 7 | `07-reports` | Which report screen reads which data |
| 8 | `08-live-offline` | Live updates, the phone's offline queue, slow Wi-Fi, no internet |

- `*.mmd`: the sources (Mermaid). Edit these. `00-key.html` is the key page.
- `export/onetap-pos-diagrams.pdf`: all diagrams, one page each (A3). Best for
  Freeform: it stays sharp when you zoom.
- `export/*.png` / `export/*.svg`: one image per diagram.

Every diagram uses the same colours (see the key page): blue = action, screen
or app; orange = decision or till rule; teal = stored data; green / yellow /
red = good / warning / problem; purple = outside the venue; grey = printers;
dashed = note. Keep to these `classDef` names (`step`, `logic`, `data`,
`good`, `warn`, `bad`, `ext`, `device`, `note`) when editing.

Each page is stamped with the app version and the date of the last code
change it was drawn from, so you can tell when a diagram may be out of date.

Small grey italic text under a box (e.g. *fiscal/claims.ts*) is where that
step lives in the code, under `src/main/services/` unless the path says
otherwise.

## Re-export after editing

Rendering uses Mermaid with the ELK layout by default and dagre where a
file's front matter asks for it (`layout: dagre`), in
the Chromium that Playwright drives. One-time setup, outside the repo:

```bash
mkdir -p /tmp/mermaid && cd /tmp/mermaid && npm init -y
npm install mermaid@11.4.1 @mermaid-js/layout-elk@0.1.7 esbuild@0.25.8
printf "import mermaid from 'mermaid';\nimport elk from '@mermaid-js/layout-elk';\nmermaid.registerLayoutLoaders(elk);\nwindow.mermaid = mermaid;\n" > entry.mjs
npx esbuild entry.mjs --bundle --format=iife --outfile=bundle.js
```

Then, from the repo root:

```bash
node docs/diagrams/render.cjs /tmp/mermaid/bundle.js
```

Writing tips: a label that starts with `1.` is read as a Markdown list and
fails to draw; write `Step 1 ·` instead.
