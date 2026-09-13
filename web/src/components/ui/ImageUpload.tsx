import { useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { ImagePlus } from "lucide-react";
import { cn } from "../../lib/cn";
import { focusRingClass } from "./a11y";
import Button from "./Button";
import { FieldError, FieldLabel } from "./Field";
import { fileToAvatarDataUri } from "./imageTransform";

export interface ImageUploadProps {
  /** The current data-URI (or null). Drives the preview. */
  value: string | null;
  /** Fires with the new data-URI on a successful upload, or null on Clear. */
  onChange: (dataUri: string | null) => void;
  label?: string;
  /** Injectable file→data-URI transform. Defaults to the real canvas
   * downscaler (`imageTransform.ts`); tests pass a stub so no real
   * canvas/decode is needed. */
  transformFile?: (file: File) => Promise<string>;
}

const ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * A labeled image picker that downscales + caps the chosen file to a `data:`
 * URI (via `transformFile`) and hands it up through `onChange`. Shows a
 * preview and a Clear button. Reusable — Contacts uses it for an avatar,
 * Subscriptions will use it for a vendor logo.
 */
function ImageUpload({
  value,
  onChange,
  label = "Image",
  transformFile = fileToAvatarDataUri,
}: ImageUploadProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the input so re-selecting the same file still fires `change`.
    event.target.value = "";
    if (!file) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const dataUri = await transformFile(file);
      onChange(dataUri);
    } catch {
      setError("Couldn't use that image. Please try a smaller one (PNG, JPEG, or WebP).");
    } finally {
      setBusy(false);
    }
  }

  function handleClear() {
    setError(null);
    onChange(null);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <div className="flex items-center gap-3">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-hairline bg-surface-2 text-ink-faint">
          {value ? (
            <img src={value} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            <ImagePlus aria-hidden="true" className="h-5 w-5" />
          )}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={busy}
            onClick={() => inputRef.current?.click()}
          >
            {value ? "Replace" : "Upload image"}
          </Button>
          {value ? (
            <Button type="button" variant="quiet" size="sm" onClick={handleClear}>
              Clear
            </Button>
          ) : null}
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPT}
          onChange={(event) => void handleFile(event)}
          className={cn("sr-only", focusRingClass)}
        />
      </div>
      {error ? <FieldError id={`${inputId}-error`}>{error}</FieldError> : null}
    </div>
  );
}

export default ImageUpload;
