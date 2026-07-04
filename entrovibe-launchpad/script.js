/* =========================================================================
   Entrovibe Launchpad — script.js
   Vanilla JS. No dependencies.
   ========================================================================= */
(function () {
  "use strict";

  /* -----------------------------------------------------------------------
     CONFIG — edit these values for your own deployment
  ----------------------------------------------------------------------- */
  var CONFIG = {
    // Replace with your real payment link (Razorpay Payment Link, Instamojo,
    // Gumroad, Stripe Payment Link, etc). Leave empty to show the demo modal.
    BUY_URL: "",
    PRICE_LABEL: "₹299",
    // Countdown length in hours for the evergreen scarcity timer.
    COUNTDOWN_HOURS: 12,
    COUNTDOWN_STORAGE_KEY: "entrovibe_offer_deadline"
  };

  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.addEventListener("DOMContentLoaded", function () {
    initLoader();
    initCursor();
    initScrollProgress();
    initNavbar();
    initMobileNav();
    initReveal();
    initCounters();
    initAccordion();
    initCountdown();
    initRipple();
    initBuyFlow();
    initModal();
    initBackToTop();
    initMobileBuyBar();
    initYear();
  });

  /* -----------------------------------------------------------------------
     Loading screen
  ----------------------------------------------------------------------- */
  function initLoader() {
    var loader = document.getElementById("loader");
    if (!loader) return;
    var hide = function () {
      loader.classList.add("is-hidden");
      document.body.style.overflow = "";
      window.removeEventListener("load", hide);
    };
    // Hide once everything has loaded, with a small minimum display time
    // so the loader doesn't just flash on fast connections.
    var minTimer = new Promise(function (resolve) { setTimeout(resolve, 550); });
    var loaded = new Promise(function (resolve) {
      if (document.readyState === "complete") { resolve(); }
      else { window.addEventListener("load", resolve, { once: true }); }
    });
    Promise.all([minTimer, loaded]).then(hide);
  }

  /* -----------------------------------------------------------------------
     Custom cursor (desktop / fine pointer only)
  ----------------------------------------------------------------------- */
  function initCursor() {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    document.documentElement.classList.add("has-fine-pointer");
    var dot = document.querySelector(".cursor-dot");
    var ring = document.querySelector(".cursor-ring");
    if (!dot || !ring) return;

    var mouseX = 0, mouseY = 0, ringX = 0, ringY = 0;

    window.addEventListener("mousemove", function (e) {
      mouseX = e.clientX;
      mouseY = e.clientY;
      dot.style.transform = "translate(" + mouseX + "px," + mouseY + "px) translate(-50%,-50%)";
    });

    function loop() {
      ringX += (mouseX - ringX) * 0.18;
      ringY += (mouseY - ringY) * 0.18;
      ring.style.transform = "translate(" + ringX + "px," + ringY + "px) translate(-50%,-50%)";
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    var interactiveSelector = "a, button, .acc-trigger, [data-buy-trigger]";
    document.addEventListener("mouseover", function (e) {
      if (e.target.closest(interactiveSelector)) ring.classList.add("is-active");
    });
    document.addEventListener("mouseout", function (e) {
      if (e.target.closest(interactiveSelector)) ring.classList.remove("is-active");
    });
  }

  /* -----------------------------------------------------------------------
     Scroll progress bar
  ----------------------------------------------------------------------- */
  function initScrollProgress() {
    var bar = document.getElementById("scrollProgressBar");
    if (!bar) return;
    var update = function () {
      var scrollTop = window.scrollY;
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      var pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
      bar.style.width = pct + "%";
    };
    window.addEventListener("scroll", onScroll(update), { passive: true });
    update();
  }

  /* -----------------------------------------------------------------------
     Sticky glass navbar + active state on scroll
  ----------------------------------------------------------------------- */
  function initNavbar() {
    var navbar = document.getElementById("navbar");
    if (!navbar) return;
    var update = function () {
      navbar.classList.toggle("is-scrolled", window.scrollY > 24);
    };
    window.addEventListener("scroll", onScroll(update), { passive: true });
    update();
  }

  /* -----------------------------------------------------------------------
     Mobile nav toggle
  ----------------------------------------------------------------------- */
  function initMobileNav() {
    var toggle = document.getElementById("navToggle");
    var links = document.getElementById("navLinks");
    if (!toggle || !links) return;

    toggle.addEventListener("click", function () {
      var expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      links.classList.toggle("is-open");
      document.body.classList.toggle("nav-open", !expanded);
    });

    links.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        toggle.setAttribute("aria-expanded", "false");
        links.classList.remove("is-open");
        document.body.classList.remove("nav-open");
      });
    });
  }

  /* -----------------------------------------------------------------------
     Reveal-on-scroll animations
  ----------------------------------------------------------------------- */
  function initReveal() {
    var items = document.querySelectorAll("[data-reveal]");
    if (!items.length) return;

    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });

    items.forEach(function (el) { observer.observe(el); });
  }

  /* -----------------------------------------------------------------------
     Animated counters
  ----------------------------------------------------------------------- */
  function initCounters() {
    var counters = document.querySelectorAll(".stat-number[data-count]");
    if (!counters.length) return;

    var animate = function (el) {
      var target = parseInt(el.getAttribute("data-count"), 10) || 0;
      var suffix = el.getAttribute("data-suffix") || "";
      var duration = 1800;
      var start = null;

      if (prefersReducedMotion) {
        el.textContent = formatNumber(target) + suffix;
        return;
      }

      function step(timestamp) {
        if (start === null) start = timestamp;
        var progress = Math.min((timestamp - start) / duration, 1);
        var eased = 1 - Math.pow(1 - progress, 3);
        var value = Math.floor(eased * target);
        el.textContent = formatNumber(value) + suffix;
        if (progress < 1) requestAnimationFrame(step);
        else el.textContent = formatNumber(target) + suffix;
      }
      requestAnimationFrame(step);
    };

    if (!("IntersectionObserver" in window)) {
      counters.forEach(animate);
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          animate(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.6 });

    counters.forEach(function (el) { observer.observe(el); });
  }

  function formatNumber(n) {
    return n.toLocaleString("en-IN");
  }

  /* -----------------------------------------------------------------------
     FAQ accordion
  ----------------------------------------------------------------------- */
  function initAccordion() {
    var triggers = document.querySelectorAll(".acc-trigger");
    triggers.forEach(function (trigger) {
      trigger.addEventListener("click", function () {
        var isOpen = trigger.getAttribute("aria-expanded") === "true";
        triggers.forEach(function (t) { t.setAttribute("aria-expanded", "false"); });
        trigger.setAttribute("aria-expanded", String(!isOpen));
      });
    });
  }

  /* -----------------------------------------------------------------------
     Scarcity countdown (evergreen, persisted per-visitor in localStorage)
  ----------------------------------------------------------------------- */
  function initCountdown() {
    var hEl = document.getElementById("cd-h");
    var mEl = document.getElementById("cd-m");
    var sEl = document.getElementById("cd-s");
    if (!hEl || !mEl || !sEl) return;

    var deadline;
    try {
      var stored = localStorage.getItem(CONFIG.COUNTDOWN_STORAGE_KEY);
      deadline = stored ? parseInt(stored, 10) : null;
      if (!deadline || deadline < Date.now()) {
        deadline = Date.now() + CONFIG.COUNTDOWN_HOURS * 60 * 60 * 1000;
        localStorage.setItem(CONFIG.COUNTDOWN_STORAGE_KEY, String(deadline));
      }
    } catch (e) {
      deadline = Date.now() + CONFIG.COUNTDOWN_HOURS * 60 * 60 * 1000;
    }

    function pad(n) { return String(n).padStart(2, "0"); }

    function tick() {
      var remaining = deadline - Date.now();
      if (remaining <= 0) {
        deadline = Date.now() + CONFIG.COUNTDOWN_HOURS * 60 * 60 * 1000;
        try { localStorage.setItem(CONFIG.COUNTDOWN_STORAGE_KEY, String(deadline)); } catch (e) {}
        remaining = deadline - Date.now();
      }
      var hours = Math.floor(remaining / 3600000);
      var minutes = Math.floor((remaining % 3600000) / 60000);
      var seconds = Math.floor((remaining % 60000) / 1000);
      hEl.textContent = pad(hours);
      mEl.textContent = pad(minutes);
      sEl.textContent = pad(seconds);
    }

    tick();
    setInterval(tick, 1000);
  }

  /* -----------------------------------------------------------------------
     Button ripple effect
  ----------------------------------------------------------------------- */
  function initRipple() {
    document.querySelectorAll(".ripple").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var rect = btn.getBoundingClientRect();
        var size = Math.max(rect.width, rect.height);
        var circle = document.createElement("span");
        var x = (e.clientX || rect.left + rect.width / 2) - rect.left - size / 2;
        var y = (e.clientY || rect.top + rect.height / 2) - rect.top - size / 2;

        circle.className = "ripple-circle";
        circle.style.width = circle.style.height = size + "px";
        circle.style.left = x + "px";
        circle.style.top = y + "px";

        btn.appendChild(circle);
        circle.addEventListener("animationend", function () { circle.remove(); });
      });
    });
  }

  /* -----------------------------------------------------------------------
     Buy flow — opens configured payment link or the demo success modal
  ----------------------------------------------------------------------- */
  function initBuyFlow() {
    // Only intercept the actual purchase buttons (inside the pricing card, final CTA, and mobile bar).
    // Buttons elsewhere (navbar, hero) just smooth-scroll to #pricing via their normal anchor href.
    document.querySelectorAll("[data-buy-trigger]").forEach(function (btn) {
      var isCheckoutButton = btn.closest(".pricing-card") || btn.closest(".final-cta") || btn.closest(".mobile-buy-bar");
      if (!isCheckoutButton) return;

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        if (CONFIG.BUY_URL) {
          showToast("Redirecting to secure checkout…");
          window.open(CONFIG.BUY_URL, "_blank", "noopener");
        } else {
          openModal();
        }
      });
    });
  }

  /* -----------------------------------------------------------------------
     Success / demo modal
  ----------------------------------------------------------------------- */
  var modalEl, modalCloseBtn, modalOkBtn, lastFocusedEl;

  function initModal() {
    modalEl = document.getElementById("successModal");
    modalCloseBtn = document.getElementById("modalClose");
    modalOkBtn = document.getElementById("modalOk");
    if (!modalEl) return;

    modalCloseBtn.addEventListener("click", closeModal);
    modalOkBtn.addEventListener("click", closeModal);
    modalEl.addEventListener("click", function (e) {
      if (e.target === modalEl) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modalEl.hasAttribute("hidden")) closeModal();
    });
  }

  function openModal() {
    if (!modalEl) return;
    lastFocusedEl = document.activeElement;
    modalEl.hidden = false;
    requestAnimationFrame(function () { modalEl.classList.add("is-open"); });
    modalCloseBtn.focus();
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.remove("is-open");
    document.body.style.overflow = "";
    setTimeout(function () {
      modalEl.hidden = true;
      if (lastFocusedEl) lastFocusedEl.focus();
    }, 300);
  }

  /* -----------------------------------------------------------------------
     Toast notifications
  ----------------------------------------------------------------------- */
  var toastTimer;
  function showToast(message) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("is-visible"); }, 3200);
  }

  /* -----------------------------------------------------------------------
     Back to top button
  ----------------------------------------------------------------------- */
  function initBackToTop() {
    var btn = document.getElementById("backToTop");
    if (!btn) return;
    var update = function () { btn.classList.toggle("is-visible", window.scrollY > 700); };
    window.addEventListener("scroll", onScroll(update), { passive: true });
    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
    });
    update();
  }

  /* -----------------------------------------------------------------------
     Sticky mobile buy bar (shows once hero CTA scrolls out of view)
  ----------------------------------------------------------------------- */
  function initMobileBuyBar() {
    var bar = document.getElementById("mobileBuyBar");
    var hero = document.getElementById("hero");
    if (!bar || !hero) return;

    if (!("IntersectionObserver" in window)) {
      bar.classList.add("is-visible");
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        bar.classList.toggle("is-visible", !entry.isIntersecting);
      });
    }, { threshold: 0 });
    observer.observe(hero);
  }

  /* -----------------------------------------------------------------------
     Footer year
  ----------------------------------------------------------------------- */
  function initYear() {
    var el = document.getElementById("year");
    if (el) el.textContent = new Date().getFullYear();
  }

  /* -----------------------------------------------------------------------
     Scroll handler throttled via requestAnimationFrame
  ----------------------------------------------------------------------- */
  function onScroll(fn) {
    var ticking = false;
    return function () {
      if (!ticking) {
        requestAnimationFrame(function () { fn(); ticking = false; });
        ticking = true;
      }
    };
  }
})();
