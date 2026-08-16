/**
 * A map pinch, expressed as a ctrl-wheel at the element's centre.
 *
 * Neither engine has a first-class pinch. Maps (Leaflet, Mapbox, Google) treat
 * ctrl-wheel as zoom, and both adapters already have `evaluate`, so the gesture
 * lives here once rather than being retyped per engine — a second copy would
 * be two chances to disagree about the delta.
 *
 * The body is a STRING on purpose: it runs in the page, and this package's
 * tsconfig has no DOM lib. `VITALS_EXPRESSION` is the same shape.
 */
export type PinchDirection = "in" | "out";

const PINCH_FN = `function pinchAt(selector, deltaY) {
  const el = document.querySelector(selector);
  if (!el) throw new Error("pinch: no element for " + selector);
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: deltaY,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2
  }));
  return true;
}`;

export function pinchExpression(selector: string, direction: PinchDirection): string {
  const deltaY = direction === "in" ? -120 : 120;
  return `(${PINCH_FN})(${JSON.stringify(selector)}, ${deltaY})`;
}
