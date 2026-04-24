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
    return {
      scaleX,
      scaleY,
      sizeScale: scaleX
    };
  }

  function scaleRectByLayout(rect, fromSize, toSize) {
    if (!rect) return null;
    const transform = computeLayoutTransform(fromSize, toSize);
    return {
      x: rect.x * transform.scaleX,
      y: rect.y * transform.scaleY,
      width: rect.width * transform.sizeScale,
      height: rect.height * transform.sizeScale
    };
  }

  return {
    normalizeSize,
    computeLayoutTransform,
    scaleRectByLayout
  };
});
