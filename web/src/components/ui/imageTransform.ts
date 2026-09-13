/**
 * The client-side image pipeline behind `ImageUpload`: downscale a chosen
 * image via `<canvas>` to a small square-bounded thumbnail and encode it to a
 * size-capped `data:` URI. Kept in its own module (not colocated with the
 * component) so the pure `fitWithin` math is unit-testable and the
 * canvas/decode path — which jsdom can't run — is injected into `ImageUpload`
 * via its `transformFile` prop and mocked in tests.
 */

/** The data-URI byte cap, matched to the server's `MAX_AVATAR_BYTES`
 * (`api/src/pecunia/services/contacts.py`) so anything this produces is
 * accepted. The data URI is pure ASCII (`data:` prefix + base64), so its
 * `.length` equals its UTF-8 byte length. */
export const MAX_AVATAR_BYTES = 64 * 1024;

/** The longest edge an avatar is downscaled to — small on purpose (it's shown
 * at ≤48px), which is what keeps the encoded size well under the cap. */
export const MAX_DIMENSION = 128;

/** The formats/qualities tried in order until one lands under the byte cap.
 * webp first (best compression, an accepted type), jpeg as the fallback for
 * browsers that don't encode webp (`toDataURL` silently returns png then — we
 * detect the prefix and skip it, falling through to jpeg). */
const ENCODE_ATTEMPTS: { type: "image/webp" | "image/jpeg"; quality: number }[] = [
  { type: "image/webp", quality: 0.82 },
  { type: "image/webp", quality: 0.6 },
  { type: "image/webp", quality: 0.4 },
  { type: "image/jpeg", quality: 0.8 },
  { type: "image/jpeg", quality: 0.55 },
  { type: "image/jpeg", quality: 0.35 },
];

/** Raised when even the most aggressive re-encode can't fit the cap — the
 * component surfaces it as a friendly "try a smaller image" message. */
export class ImageTooLargeError extends Error {
  constructor() {
    super("IMAGE_TOO_LARGE");
    this.name = "ImageTooLargeError";
  }
}

/**
 * Fit `(width, height)` within a `max`×`max` square preserving aspect ratio,
 * never upscaling (a smaller source is left as-is). Pure and exported so the
 * scaling math is unit-testable without a real canvas.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_DIMENSION,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Load a `File` into a decoded `HTMLImageElement` via an object URL, revoking
 * it once the image resolves (or fails). */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("IMAGE_DECODE_FAILED"));
    };
    image.src = url;
  });
}

/**
 * The real transform: read an image file, downscale it via `<canvas>` to fit
 * within {@link MAX_DIMENSION}px, and encode it to a
 * `data:image/(webp|jpeg);base64,…` URI capped at {@link MAX_AVATAR_BYTES}
 * (stepping quality/format down until it fits). Throws {@link ImageTooLargeError}
 * if nothing fits.
 */
export async function fileToAvatarDataUri(file: File): Promise<string> {
  const image = await loadImage(file);
  const source = fitWithin(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, source.width);
  canvas.height = Math.max(1, source.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("CANVAS_UNAVAILABLE");
  }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  for (const { type, quality } of ENCODE_ATTEMPTS) {
    const uri = canvas.toDataURL(type, quality);
    // A browser that can't encode `type` returns a png — skip those and let a
    // supported attempt win.
    if (uri.startsWith(`data:${type}`) && uri.length <= MAX_AVATAR_BYTES) {
      return uri;
    }
  }
  throw new ImageTooLargeError();
}
