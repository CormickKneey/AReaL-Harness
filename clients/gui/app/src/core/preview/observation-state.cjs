// @ts-check
"use strict";
/** @param {import("../preview-native/model.js").Page} page */
function invalidateActionObservation(page) {
  page.refs.clear();
  page.nativeControls.clear();
  page.optionIds.clear();
  page.lastObservation = null;
  page.observedViewportKey = null;
  page.needsObservation = true;
  page.lastCapture = null;
  invalidateDocumentPlans(page);
}

const coordinateKinds = new Set(["clickAt", "drag", "pressAt"]);
/** @param {string} operation @param {object | undefined} parameters */
const documentReadyWait = (operation, parameters) =>
  operation === "wait" &&
  parameters !== undefined &&
  "condition" in parameters &&
  parameters.condition !== null &&
  typeof parameters.condition === "object" &&
  "kind" in parameters.condition &&
  parameters.condition.kind === "documentReady";
/** @param {import("../preview-native/model.js").Page} page */
function invalidateDocumentPlans(page) {
  // Readiness has no element target: keep only same-Origin, same-control waits.
  for (const [id, record] of page.plans) {
    if (
      !documentReadyWait(
        record.plan.operation,
        "action" in record.plan ? record.plan.action : undefined,
      )
    )
      page.plans.delete(id);
  }
}

const viewportScript = `({width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio})`;

module.exports = {
  invalidateActionObservation,
  documentReadyWait,
  invalidateDocumentPlans,
  coordinateKinds,
  viewportScript,
};
