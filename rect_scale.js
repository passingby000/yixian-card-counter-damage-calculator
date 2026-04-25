(function initRectScale(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RectScale = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRectScaleApi() {
  function toPositiveNumber(value, fallback = 1) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeSize(size, fallback = { width: 1, height: 1 }) {
    return {
      width: toPositiveNumber(size?.width, fallback.width),
      height: toPositiveNumber(size?.height, fallback.height)
    };
  }

  function computeLayoutTransform(fromSize, toSize) {
    const source = normalizeSize(fromSize);
    const target = normalizeSize(toSize);
    const scaleX = target.width / source.width;
    const scaleY = target.height / source.height;
    // Size scales must match the dimension they apply to. Aliasing them to a
    // single value causes rect heights to be wrong whenever source and target
    // aspect ratios differ (e.g. windowed mode, DWM-trimmed contentRect).
    return {
      scaleX,
      scaleY,
      sizeScaleX: scaleX,
      sizeScaleY: scaleY
    };
  }

  function scaleRectByLayout(rect, fromSize, toSize) {
    if (!rect) return null;
    const transform = computeLayoutTransform(fromSize, toSize);
    return {
      x: rect.x * transform.scaleX,
      y: rect.y * transform.scaleY,
      width: rect.width * transform.sizeScaleX,
      height: rect.height * transform.sizeScaleY
    };
  }

  return {
    normalizeSize,
    computeLayoutTransform,
    scaleRectByLayout
  };
});
