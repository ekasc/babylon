// SVG to PNG, in the renderer.
//
// The main process has no canvas, and a crop is something a model has to look at,
// so this is the one step of the sketch pipeline that has to happen where there
// is a DOM. Kept apart from the crop builder so the crop itself stays testable
// without a browser.

export async function rasterizeSvg(svg: string, width: number, height: number): Promise<string> {
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("the crop could not be drawn"));
    image.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d canvas in this renderer");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}
