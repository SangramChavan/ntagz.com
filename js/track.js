// `home` as a function = the carrier accepts a prefilled tracking ID in the URL.
// As a plain string = it does not (OTP / captcha / POST-only); we copy the ID instead.
const CARRIERS = {
  delhivery: { name: "Delhivery", home: "https://www.delhivery.com/tracking" },
  bluedart:  { name: "Blue Dart", home: "https://www.bluedart.com/track-trace" },
  trackon:   { name: "Trackon", home: "https://www.trackon.in/courier-tracking" },
  ekart:     { name: "Ekart Logistics", home: (id) => `https://ekartlogistics.com/shipmenttrack/${id}` }
};

function trackingUrl(carrier, id) {
  const c = CARRIERS[carrier] || CARRIERS.delhivery;
  return typeof c.home === "function" ? c.home(encodeURIComponent(id)) : c.home;
}

function handleTracking(e) {
  e.preventDefault();
  const input = document.getElementById("trackingId");
  const trackingId = input.value.trim();
  if (!trackingId) return;

  const hint = document.getElementById("trackCopied");
  hint.hidden = true;

  const carrier = document.getElementById("carrier").value;
  const c = CARRIERS[carrier];

  if (typeof c.home !== "function") {
    navigator.clipboard?.writeText(trackingId).then(() => {
      hint.textContent = `Tracking ID copied — paste it on the ${c.name} site.`;
      hint.hidden = false;
    }, () => {});
  }

  window.open(trackingUrl(carrier, trackingId), "_blank", "noopener,noreferrer");
}

document.getElementById("carrier").addEventListener("change", (e) => {
  document.getElementById("trackCopied").hidden = true;
  document.getElementById("trackBtn").textContent =
    `Track via ${CARRIERS[e.target.value].name} →`;
});
