# Entrovibe Launchpad — Landing Page

A production-ready, single-page marketing site for **Entrovibe Launchpad**, built with plain HTML5, CSS3 and vanilla JavaScript — no frameworks, no build step. Deploy it to Netlify as-is.

This build is wired with your real details (checkout link, contact, domain, policies) pulled from your live `entrovibelaunchpad.in` export — see [What's already live](#whats-already-live-real-data) below.

## What's inside

```
entrovibe-launchpad/
├── index.html            Main landing page (all sections)
├── privacy.html          Privacy Policy
├── terms.html            Terms & Conditions (reseller license, no-refund policy)
├── refund.html           Refund Policy
├── thankyou/index.html   Post-purchase page (Discord invite) — payment gateway success-redirect target
├── 404.html              Custom not-found page
├── style.css             Full design system + responsive layout + animations
├── script.js             All interactivity (see CONFIG block at the top)
├── manifest.json         Web app manifest (PWA-ready icons)
├── robots.txt
├── sitemap.xml
├── netlify.toml          Netlify build + headers config
├── assets/
│   ├── favicon.svg
│   ├── proof/            Real community proof screenshots (Discord wins, IG growth)
│   └── icons/
│       ├── favicon-32.png
│       ├── apple-touch-icon.png
│       ├── icon-192.png
│       ├── icon-512.png
│       └── og-image.png  Open Graph / Twitter share image (1200×630)
└── README.md
```

No CSS/JS frameworks or build tooling are used — everything renders from these files alone. The only external network call is the Meta Pixel (see below), which is optional and easy to remove.

## What's already live (real data)

Pulled directly from your `entrovibelaunchpad.in` export, already wired in:

- **Checkout** — every "Get Access" button in the pricing card, final CTA, and mobile buy bar opens your real Superprofile checkout: `https://superprofile.bio/vp/get-launchpad?checkout=true` (set in `script.js` → `CONFIG.BUY_URL`).
- **Domain** — canonical URL, Open Graph, Twitter Cards and JSON-LD all point to `https://entrovibelaunchpad.in`.
- **Contact** — `getyourdigitalthingsdone@gmail.com` and your Instagram (`@getyourdigitalthingsdone`) throughout, matching your real `contact.html`.
- **Pricing anchor** — ₹2,999 → ₹299, matching your live checkout spec sheet (not an invented number).
- **Policies** — `terms.html`, `privacy.html` and `refund.html` mirror your real, currently-published policy: **all sales are final, no refunds once access is granted** (digital product), reseller disclaimer, earnings disclaimer, and Meta Pixel disclosure (Superprofile/Gumroad named as payment processors).
- **Post-purchase flow** — `thankyou/index.html` is built at the same `/thankyou/` path your export uses, with your real Discord invite (`discord.com/invite/c7VWchQF7R`) and a `Purchase` Meta Pixel event (₹299 INR). If your payment gateway's "success URL" is already configured to point here, it keeps working with zero changes.
- **Social proof** — the testimonials section uses four real screenshots from your private Discord community (`#launchpad-wins`) and member Instagram growth, not placeholder quotes.
- **Meta Pixel** — your pixel ID (`1311806951161601`) fires `PageView`/`ViewContent` on load and `InitiateCheckout` on every buy click, matching your original setup.

## Deploying to Netlify

**Option A — drag & drop**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag the entire `entrovibe-launchpad` folder onto the page.
3. Netlify deploys it instantly at a generated `*.netlify.app` URL.

**Option B — Git**
1. Push this folder to a GitHub/GitLab/Bitbucket repo.
2. In Netlify: **Add new site → Import an existing project**.
3. Build command: *(leave blank)*. Publish directory: `.` (already set in `netlify.toml`).
4. Deploy.

**Custom domain:** Netlify → Site settings → Domain management → add `entrovibelaunchpad.in` and point your DNS as instructed. If you're moving off your previous host/page-builder, also re-check the checkout success-redirect URL in your Superprofile settings still points at `/thankyou/` on the new host.

## Before you go live — remaining checklist

- [ ] **Verify the Superprofile checkout link is still active** (`https://superprofile.bio/vp/get-launchpad?checkout=true`) — links to third-party checkout pages can change if you edit the product in Superprofile.
- [ ] **Double-check the Discord invite hasn't expired** — Discord invite links can expire or hit a use-limit; confirm `discord.com/invite/c7VWchQF7R` is still valid, or generate a permanent one.
- [ ] **Legal pages** — `privacy.html`, `terms.html`, `refund.html` mirror your currently-published policy. If you change your actual refund/data practices, update these files (and your live site) together so they stay in sync.
- [ ] **OG image** — regenerate `assets/icons/og-image.png` if you change headline copy (any 1200×630 screenshot/design tool works).

## Customization guide

- **Colors / spacing / radii** — all design tokens live at the top of `style.css` inside `:root` (`--bg`, `--gold`, `--radius`, etc.). Changing a token updates the whole site.
- **Copy** — all marketing text lives directly in `index.html`; no CMS or data file layer.
- **Countdown timer** — `CONFIG.COUNTDOWN_HOURS` in `script.js` controls how long the scarcity countdown runs before it resets for a given visitor (stored in `localStorage`, resets automatically when it expires — a standard evergreen-deadline pattern).
- **Sections** — every section in `index.html` is a self-contained `<section>`; reorder, duplicate or remove them independently.
- **Meta Pixel** — to remove tracking entirely, delete the `<script>` block after the JSON-LD in `index.html`'s `<head>`, the matching block in `thankyou/index.html`, and the `fbq` call in `script.js`'s buy-click handler.

## Features implemented

- Loading screen, sticky glass navbar, scroll progress bar, back-to-top button
- Custom premium cursor (desktop/fine-pointer only — automatically disabled on touch devices)
- Scroll-reveal animations, animated counters, floating hero elements, parallax glow orbs
- Button ripple effect, FAQ accordion, evergreen scarcity countdown
- Sticky mobile "buy" bar, real checkout redirect + toast notifications (falls back to a demo modal only if `CONFIG.BUY_URL` is ever cleared)
- Fully responsive from 320px (iPhone SE) up through ultrawide desktop monitors, with no horizontal scrolling at any breakpoint
- Semantic HTML5, skip link, visible focus states, `prefers-reduced-motion` support
- SEO: meta description/keywords, canonical URL, Open Graph, Twitter Cards, JSON-LD (`Product` + `FAQPage`), `robots.txt`, `sitemap.xml`, `manifest.json`

## Local preview

Any static file server works, for example:

```bash
npx http-server .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080` (or the port shown). Note: the Meta Pixel request will fail in offline/sandboxed environments — that's expected and harmless; it works normally once deployed.

## Browser support

Modern evergreen browsers (Chrome, Edge, Safari, Firefox) on desktop, iOS and Android. CSS fallbacks are in place for browsers without `backdrop-filter` or `:has()` support — the layout and content remain fully usable, only glass-blur and a couple of accordion transitions degrade gracefully.
