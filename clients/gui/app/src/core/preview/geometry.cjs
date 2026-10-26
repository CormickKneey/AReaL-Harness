// @ts-check
"use strict";
/** @typedef {{width:number,height:number,bitmapWidth:number,bitmapHeight:number}} CaptureDimensions */
/** @typedef {{x:number,y:number,width:number,height:number}} PreviewBounds */
/** @param {CaptureDimensions} capture @param {number} x @param {number} y */
function bitmapPoint(capture, x, y) {
  const { width, height, bitmapWidth, bitmapHeight } = capture;
  if (
    ![width, height, bitmapWidth, bitmapHeight].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    bitmapWidth <= 0 ||
    bitmapHeight <= 0 ||
    x < 0 ||
    y < 0 ||
    x >= bitmapWidth ||
    y >= bitmapHeight
  )
    throw new Error("target_unavailable");
  // CDP Input uses page CSS viewport coordinates; the actual bitmap dimensions
  // are the only safe conversion source across DPR and page/GUI zoom.
  const cssPixelSubdivisions = 64;
  return {
    x: Math.round(((x * width) / bitmapWidth) * cssPixelSubdivisions) / cssPixelSubdivisions,
    y: Math.round(((y * height) / bitmapHeight) * cssPixelSubdivisions) / cssPixelSubdivisions,
  };
}
/** @param {CaptureDimensions} capture
 * @param {{kind:'drag',fromX:number,fromY:number,toX:number,toY:number,steps:number}|{kind:'clickAt'|'pressAt',x:number,y:number}} action */
function coordinateTarget(capture, action) {
  if (action.kind === "drag")
    return {
      from: bitmapPoint(capture, action.fromX, action.fromY),
      to: bitmapPoint(capture, action.toX, action.toY),
      steps: action.steps,
    };
  return { point: bitmapPoint(capture, action.x, action.y) };
}
/** @param {PreviewBounds|null|undefined} value @param {number[]} size */
function boundsWithinWindow(value, size) {
  if (
    !value ||
    /** @type {(keyof PreviewBounds)[]} */ (["x", "y", "width", "height"]).some(
      (key) => !Number.isFinite(value[key]),
    )
  )
    throw new Error("无效预览区域");
  const x = Math.max(0, Math.round(value.x)),
    y = Math.max(0, Math.round(value.y));
  return {
    x: Math.min(x, size[0]),
    y: Math.min(y, size[1]),
    width: Math.max(0, Math.min(Math.round(value.width), size[0] - x)),
    height: Math.max(0, Math.min(Math.round(value.height), size[1] - y)),
  };
}
module.exports = { bitmapPoint, coordinateTarget, boundsWithinWindow };
