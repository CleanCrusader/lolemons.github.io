// js/conversion.js
//
// Google Ads purchase conversion, fired once on success.html after Stripe
// redirects back with ?session_id=... Sends only order value, currency and
// the Stripe session id (as transaction_id, which Google uses to de-duplicate).
// No name, email or address. Respects the opt-out in js/consent.js.
//
// INERT until SEND_TO is set to the conversion "send_to" value from Google Ads
// (format: "AW-362740851/<conversion label>").

(function () {
  var SEND_TO = "AW-362740851/fpNcCJCFwqAdEPP4-6wB";
  if (!SEND_TO) return;

  var sid = new URLSearchParams(location.search).get("session_id");
  if (!sid) return;
  if (window.lolAdsOptedOut && window.lolAdsOptedOut()) return;
  try { if (localStorage.getItem("lol_conv_" + sid)) return; } catch (e) {}

  fetch("/api/checkout-summary?session_id=" + encodeURIComponent(sid))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.paid || !window.gtag) return;
      window.gtag("event", "conversion", {
        send_to: SEND_TO, value: d.value, currency: d.currency, transaction_id: sid
      });
      try { localStorage.setItem("lol_conv_" + sid, "1"); } catch (e) {}
    })
    .catch(function () {});
})();
