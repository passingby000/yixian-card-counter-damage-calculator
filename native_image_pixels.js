function getNativeImagePixelSize(image) {
  const logicalSize = image?.getSize?.() || {};
  const logicalWidth = Number(logicalSize.width) || 0;
  const logicalHeight = Number(logicalSize.height) || 0;
  const bitmap = image?.toBitmap?.() || null;

  if (!bitmap || bitmap.length === 0) {
    return {
      width: logicalWidth,
      height: logicalHeight
    };
  }

  const bitmapPixels = bitmap.length / 4;
  const logicalPixels = logicalWidth * logicalHeight;
  if (logicalWidth > 0 && logicalHeight > 0 && logicalPixels > 0) {
    const scale = Math.sqrt(bitmapPixels / logicalPixels);
    const width = Math.max(1, Math.round(logicalWidth * scale));
    const height = Math.max(1, Math.round(logicalHeight * scale));
    return { width, height };
  }

  return {
    width: logicalWidth,
    height: logicalHeight
  };
}

function getNativeImageOpaqueBounds(image, alphaThreshold = 32) {
  const { width, height } = getNativeImagePixelSize(image);
  const bitmap = image?.toBitmap?.() || null;

  if (!bitmap || bitmap.length === 0 || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width, height };
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = bitmap[(y * width + x) * 4 + 3];
      if (alpha < alphaThreshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width, height };
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1)
  };
}

module.exports = {
  getNativeImagePixelSize,
  getNativeImageOpaqueBounds
};
