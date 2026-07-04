# Entrovibe Launchpad — Landing Page

A production-ready, single-page marketing site for **Entrovibe Launchpad**, built with plain HTML5, CSS3 and vanilla JavaScript — no frameworks, no build step, no dependencies. Deploy it to Netlify as-is.

## What's inside

```
entrovibe-launchpad/
├── index.html          Main landing page (all sections)
├── privacy.html         Privacy Policy
├── terms.html           Terms of Service
├── refund.html          Refund Policy
├── 404.html             Custom not-found page
├── style.css            Full design system + responsive layout + animations
├── script.js            All interactivity (see CONFIG block at the top)
├── manifest.json         Web app manifest (PWA-ready icons)
├── robots.txt
├── sitemap.xml
├── netlify.toml          Netlify build + headers config
├── assets/
│   ├── favicon.svg
│   └── icons/
│       ├── favicon-32.png
│       ├── apple-touch-icon.png
│       ├── icon-192.png
│       ├── icon-512.png
│       └── og-image.png   Open Graph / Twitter share image (1200×630)
└── README.md
```

No external fonts, icon libraries, or CSS/JS frameworks are loaded — everything renders from these files alone, which keeps the site fast and fully offline-capable after first load.

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

**Custom domain:** Netlify → Site settings → Domain management → Add a domain, then point your DNS as instructed.

## Before you go live — checklist

This page ships fully designed and functional, but a few placeholders need your real details before accepting real customers:

- [ ] **Payment link** — open `script.js` and set `CONFIG.BUY_URL` to your real payment link (Razorpay Payment Link, Instamojo, Gumroad, Stripe Payment Link, etc.). Until this is set, the Buy buttons open a demo "success" modal instead of charging anyone.
- [ ] **Domain** — replace `https://www.entrovibelaunchpad.com` in `index.html` (canonical + Open Graph + Twitter tags + JSON-LD), `sitemap.xml` and `robots.txt` with your real domain.
- [ ] **Support email** — replace `support@entrovibelaunchpad.com` throughout `index.html`, `privacy.html`, `terms.html` and `refund.html`.
- [ ] **Legal pages** — `privacy.html`, `terms.html` and `refund.html` are real starting templates, not filler text, but you should adapt them (especially the refund policy) to match the terms you intend to actually honor.
- [ ] **Testimonials & stats** — the testimonials, ratings and customer counts are illustrative placeholder content written for design purposes. Swap them for real, verifiable numbers and reviews before launch.
- [ ] **OG image regeneration** — if you change the domain or headline copy, regenerate `assets/icons/og-image.png` (any 1200×630 screenshot/design tool works) so link previews stay accurate.

## Customization guide

- **Colors / spacing / radii** — all design tokens live at the top of `style.css` inside `:root` (`--bg`, `--gold`, `--radius`, etc.). Changing a token updates the whole site.
- **Copy** — all marketing text lives directly in `index.html`; no CMS or data file layer.
- **Countdown timer** — `CONFIG.COUNTDOWN_HOURS` in `script.js` controls how long the scarcity countdown runs before it resets for a given visitor (stored in `localStorage`, resets automatically when it expires — a standard evergreen-deadline pattern).
- **Sections** — every section in `index.html` is a self-contained `<section>`; reorder, duplicate or remove them independently.

## Features implemented

- Loading screen, sticky glass navbar, scroll progress bar, back-to-top button
- Custom premium cursor (desktop/fine-pointer only — automatically disabled on touch devices)
- Scroll-reveal animations, animated counters, floating hero elements, parallax glow orbs
- Button ripple effect, FAQ accordion, evergreen scarcity countdown
- Sticky mobile "buy" bar, demo success modal + toast notifications
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

Then open `http://localhost:8080` (or the port shown).

## Browser support

Modern evergreen browsers (Chrome, Edge, Safari, Firefox) on desktop, iOS and Android. CSS fallbacks are in place for browsers without `backdrop-filter` or `:has()` support — the layout and content remain fully usable, only glass-blur and a couple of accordion transitions degrade gracefully.
