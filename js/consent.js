// js/consent.js
//
// Loads the Google tag (Google Ads measurement) site-wide, with a notice and
// an opt-out. Model: notice + opt-out (US). The tag loads unless the visitor
// has opted out, or their browser sends Global Privacy Control / Do Not Track.
// Choice is stored in localStorage (key lol_ad_choice: "in" | "out").
// Controls: any [data-consent-toggle] button on the page (privacy.html).

(function () {
  var TAG_ID = "AW-362740851";
  var KEY = "lol_ad_choice";

  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  var browserOptOut = navigator.globalPrivacyControl === true || navigator.doNotTrack === "1";
  function optedOut() { return browserOptOut || get() === "out"; }

  window.lolAdsOptedOut = optedOut; // used by js/conversion.js

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };

  function clearCookies() {
    ["_gcl_au", "_gcl_aw", "_gcl_dc", "_gac_" + TAG_ID.replace("AW-", "")].forEach(function (n) {
      document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
      document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=." + location.hostname.replace(/^www\./, "");
    });
  }

  var loaded = false;
  function loadTag() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + TAG_ID;
    document.head.appendChild(s);
    gtag("js", new Date());
    gtag("config", TAG_ID);
  }

  function denyConsent() {
    gtag("consent", "update", {
      ad_storage: "denied", ad_user_data: "denied",
      ad_personalization: "denied", analytics_storage: "denied"
    });
    clearCookies();
  }

  function banner() {
    if (get() || browserOptOut || document.getElementById("lolConsent")) return;
    var b = document.createElement("div");
    b.id = "lolConsent";
    b.className = "consent-banner";
    b.setAttribute("role", "region");
    b.setAttribute("aria-label", "Advertising notice");
    b.innerHTML =
      '<p>We use Google advertising tags to measure how our ads perform. This may collect your IP address and the pages you view. ' +
      '<a href="privacy.html#choices">Learn more</a></p>' +
      '<div class="consent-actions">' +
      '<button type="button" class="btn btn-primary" data-act="in">OK</button>' +
      '<button type="button" class="btn consent-optout" data-act="out">Opt out</button></div>';
    b.addEventListener("click", function (e) {
      var act = e.target && e.target.getAttribute("data-act");
      if (!act) return;
      set(act);
      if (act === "out") denyConsent();
      b.remove();
      refreshToggles();
    });
    document.body.appendChild(b);
  }

  function refreshToggles() {
    var out = optedOut();
    document.querySelectorAll("[data-consent-toggle]").forEach(function (btn) {
      btn.textContent = out ? "Advertising measurement is OFF — turn on" : "Advertising measurement is ON — opt out";
    });
    document.querySelectorAll("[data-consent-status]").forEach(function (el) {
      el.textContent = browserOptOut
        ? "Your browser is sending a Global Privacy Control / Do Not Track signal, so the tag is off."
        : (out ? "You have opted out. The Google tag will not load." : "The Google tag is active unless you opt out.");
    });
  }

  function init() {
    if (optedOut()) { denyConsent(); } else { loadTag(); }
    banner();
    refreshToggles();
    document.querySelectorAll("[data-consent-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (browserOptOut) return;
        if (optedOut()) { set("in"); loadTag(); }
        else { set("out"); denyConsent(); }
        refreshToggles();
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
